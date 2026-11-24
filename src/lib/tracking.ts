import type { Maybe, TrackingState } from "@/types/domain";

/**
 * Engagement, derived — the single definition the whole app shares.
 *
 * `email_logs.status` answers "did the provider take the message". This answers
 * "what did the recipient do", and is derived from the counters so that no
 * enum had to change and no historical row needed backfilling.
 *
 * Deliberately conservative: an open is a tracked image request, not proof that
 * a person read the email. Apple Mail Privacy Protection and corporate link
 * scanners pre-fetch both pixels and links, which inflates exactly this number.
 */

export interface TrackingCounters {
  tracking_token?: Maybe<string>;
  open_count?: number;
  click_count?: number;
  first_open_at?: Maybe<string>;
  first_click_at?: Maybe<string>;
}

export function trackingStateOf(log: TrackingCounters): TrackingState {
  if (!log.tracking_token) return "untracked";
  if (Number(log.click_count ?? 0) > 0) return "clicked";
  if (Number(log.open_count ?? 0) > 0) return "opened";
  return "sent";
}

const STATE_COPY: Record<TrackingState, string> = {
  untracked: "not tracked",
  sent: "sent",
  opened: "opened",
  clicked: "clicked",
};

export function trackingStateLabel(state: TrackingState): string {
  return STATE_COPY[state];
}

/** Sky = informational, amber = waiting on you, mint = moving forward, grey = inert. */
export const TRACKING_TONE: Record<TrackingState, "info" | "brand" | "neutral" | "warn"> = {
  untracked: "neutral",
  sent: "info",
  opened: "warn",
  clicked: "brand",
};

export function hasEngagement(log: TrackingCounters): boolean {
  const state = trackingStateOf(log);
  return state === "opened" || state === "clicked";
}

/** `1 of 4` → `25%`; `0 of 0` → `—` rather than a fabricated 0%. */
export function rate(numerator: number, denominator: number): string {
  if (!denominator) return "—";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

/**
 * How many messages were actually opened: the sum of `open_count` is
 * image requests, which is a different number and easy to mistake for reach.
 */
export function describeOpens(openCount: number): string {
  if (openCount <= 0) return "never opened";
  if (openCount === 1) return "opened once";
  return `opened ${openCount}×`;
}

export const EVENT_LABELS: Record<string, string> = {
  open: "Tracked open",
  click: "Link click",
  sent: "Sent",
  reply: "Reply recorded",
  meeting: "Meeting recorded",
  not_interested: "Not interested",
};
