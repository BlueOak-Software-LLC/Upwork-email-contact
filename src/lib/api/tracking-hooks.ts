import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "./errors";
import type { EmailLogRow, TrackingOutcomeKind, TrackingState } from "@/types/domain";

/**
 * Client reads for engagement. The numbers themselves are server-rendered on
 * `/emails` and the Overview; these hooks exist for the actions a human takes
 * and for the settings page, which needs the live configuration.
 */

export interface TrackingStats {
  rangeDays: number;
  sent: number;
  delivered: number;
  tracked: number;
  opens: number;
  uniqueOpeners: number;
  clicks: number;
  uniqueClickers: number;
  openRate: number | null;
  clickRate: number | null;
  clickThroughRate: number | null;
  series: Array<{ date: string; opens: number; clicks: number; sent: number }>;
  /** Recipient-domain rollup, busiest first — where mail lands and what it does. */
  domains: Array<{
    domain: string;
    delivered: number;
    opened: number;
    clicks: number;
    openRate: number | null;
    clickRate: number | null;
  }>;
  /** True when 0005_email_tracking.sql has not been applied to this project. */
  schemaMissing?: boolean;
  configured: {
    enabled: boolean;
    linkTracking: boolean;
    domain: string;
    retentionDays: number;
  };
}

/** Exactly what `GET /api/email` answers with once `tracking_state` is derived. */
type EmailLogWithState = Pick<
  EmailLogRow,
  "id" | "to_email" | "status" | "tracking_token" | "open_count" | "click_count" | "last_event_at"
> & { tracking_state: TrackingState };

export function useTrackingStats(days = 14) {
  return useQuery({
    queryKey: ["tracking", "stats", days],
    queryFn: () => apiFetch<TrackingStats>("/api/tracking/stats", { query: { days } }),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useRecordOutcome() {
  const qc = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: (input: { logId: string; kind: TrackingOutcomeKind }) =>
      apiFetch<{ logId: string; eventId: string | null }>("/api/tracking/outcome", {
        method: "POST",
        body: input,
      }),
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: ["tracking"] });
      qc.invalidateQueries({ queryKey: ["email-logs"] });
      toast.success(
        variables.kind === "reply"
          ? "Reply recorded"
          : variables.kind === "meeting"
            ? "Meeting recorded"
            : "Marked not interested",
        "The delivery log, the activity timeline and the contact status all moved. Reload of this page is automatic.",
      );
    },
    onError: (error) => toast.error("Could not record that", errorMessage(error)),
  });
}

/**
 * Runs the retention purge now, instead of waiting for a schedule.
 *
 * The point is not the deleted rows: it is proof that the RPC exists and can
 * execute, which is the one part of tracking a config page cannot show by
 * reading values back.
 */
export function useRunCleanup() {
  const qc = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: () =>
      apiFetch<{ removed: number; before: string; days: number }>("/api/maintenance/purge", {
        method: "POST",
        body: {},
      }),
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: ["tracking"] });
      toast.info(
        `Retention ran · ${data.removed} event${data.removed === 1 ? "" : "s"} removed`,
        `Everything older than ${new Date(data.before).toLocaleDateString()} in the ${data.days}-day window. Delivery rows, links and recorded outcomes were not touched.`,
      );
    },
    onError: (error) => toast.error("Cleanup did not run", errorMessage(error)),
  });
}

/**
 * The delivery-log rows a draft produced, with their engagement.
 *
 * Read through `/api/email?draftId=` rather than a bespoke route: the filters
 * and the derived `tracking_state` already live there, and one draft is a
 * handful of rows (one per recipient), so this is cheap enough for a card.
 */
export interface DraftActivity {
  logId: string;
  to: string;
  status: string;
  tracked: boolean;
  openCount: number;
  clickCount: number;
  lastEventAt: string | null;
  state: "untracked" | "sent" | "opened" | "clicked";
}

export function useDraftActivity(draftId: string, enabled = true) {
  return useQuery({
    queryKey: ["tracking", "draft", draftId],
    queryFn: async () => {
      const response = await apiFetch<EmailLogWithState[]>("/api/email", {
        query: { draftId, pageSize: 20 },
      });
      return response.data.map((row) => ({
        logId: row.id,
        to: row.to_email,
        status: row.status,
        tracked: Boolean(row.tracking_token),
        openCount: Number(row.open_count ?? 0),
        clickCount: Number(row.click_count ?? 0),
        lastEventAt: row.last_event_at ?? null,
        state: row.tracking_state,
      }));
    },
    enabled: enabled && Boolean(draftId),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

/** One line for the draft card: what the recipients did, or why nothing is known. */
export function summarizeDraftActivity(rows: DraftActivity[]): string | null {
  if (rows.length === 0) return null;
  const opens = rows.reduce((sum, row) => sum + row.openCount, 0);
  const clicks = rows.reduce((sum, row) => sum + row.clickCount, 0);
  const last = rows
    .map((row) => row.lastEventAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  if (!rows.some((row) => row.tracked)) return "sent untracked — no pixel in this message";
  if (!opens && !clicks) return "delivered, not opened yet";

  const parts = [opens ? `${opens} open${opens === 1 ? "" : "s"}` : "", clicks ? `${clicks} click${clicks === 1 ? "" : "s"}` : ""]
    .filter(Boolean);
  return parts.join(" · ") + (last ? ` · last ${new Date(last).toLocaleString()}` : "");
}
