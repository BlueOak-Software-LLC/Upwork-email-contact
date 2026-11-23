"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useLeads, type LeadSummary } from "@/lib/api/outreach-hooks";
import { IngestDialog } from "./ingest-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { TimeAgo } from "@/components/ui/time-ago";
import { Input, Select } from "@/components/ui/input";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { TableSkeleton } from "@/components/ui/skeleton";
import { cn, truncate } from "@/lib/utils";
import { LEAD_STATUSES } from "@/types/lead";

export function LeadsView() {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <LeadsTable />
    </Suspense>
  );
}

function LeadsTable() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [search, setSearch] = useState(params.get("q") ?? "");
  const filters = useMemo(
    () => ({
      q: params.get("q") ?? undefined,
      status: params.get("status") ?? undefined,
      confidence: params.get("confidence") ?? undefined,
      page: Number(params.get("page") ?? 1),
      pageSize: 25,
    }),
    [params],
  );

  const { data, isLoading, isFetching, error, refetch } = useLeads(filters);
  const rows = data?.data ?? [];
  const meta = data?.meta;
  const [ingestOpen, setIngestOpen] = useState(false);

  const setParam = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    router.replace(`${pathname}?${next.toString()}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex flex-1 flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setParam("q", search.trim() || undefined);
          }}
        >
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search job title, company, client…"
            className="max-w-xs"
            aria-label="Search leads"
          />
          <Select
            aria-label="Status"
            className="w-36"
            value={params.get("status") ?? ""}
            onChange={(e) => setParam("status", e.target.value || undefined)}
          >
            <option value="">All statuses</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Confidence"
            className="w-36"
            value={params.get("confidence") ?? ""}
            onChange={(e) => setParam("confidence", e.target.value || undefined)}
          >
            <option value="">Any confidence</option>
            {["HIGH", "MEDIUM", "LOW", "UNIDENTIFIED"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary" size="sm">
            Apply
          </Button>
        </form>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            {isFetching ? (
              <>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> updating
              </>
            ) : (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-brand/60" /> live
              </>
            )}
          </span>
          <Button variant="ghost" size="sm" onClick={() => refetch()} loading={isFetching}>
            Refresh
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setIngestOpen(true)}>
            Ingest payload
          </Button>
        </div>
      </div>

      <IngestDialog open={ingestOpen} onClose={() => setIngestOpen(false)} />

      <div className="card overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={8} />
        ) : error ? (
          <EmptyState
            tone="danger"
            icon="✕"
            title="Leads could not be loaded"
            description={
              <>
                {(error as Error).message} — the table reads <code>GET /api/leads</code>; apply the
                migrations and set the Supabase env vars if this is a fresh deploy.
              </>
            }
            action={
              <Button size="sm" onClick={() => refetch()} loading={isFetching}>
                Try again
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={
              params.get("q") || params.get("status")
                ? "Nothing matches these filters"
                : "No leads yet"
            }
            description={
              params.get("q") || params.get("status") ? (
                <>Search covers the title, company, client, industry and the whole post body.</>
              ) : (
                <>
                  Every object posted to <code>POST /api/leads</code> lands here. Paste one now, or
                  point your scraper at the endpoint.
                </>
              )
            }
            action={
              <>
                {params.get("q") || params.get("status") ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSearch("");
                      router.replace(pathname);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : null}
                <Button size="sm" onClick={() => setIngestOpen(true)}>
                  Ingest payload
                </Button>
              </>
            }
          />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>Job</Th>
                <Th>Client / company</Th>
                <Th>Confidence</Th>
                <Th>Pipeline</Th>
                <Th>Status</Th>
                <Th>Received</Th>
              </Tr>
            </THead>
            <TBody>
              {rows.map((lead) => (
                <Tr
                  key={lead.id}
                  onClick={() => router.push(`/leads/${lead.id}`)}
                  className="cursor-pointer transition hover:bg-surface-2/60"
                >
                  <Td className="max-w-sm">
                    <Link
                      href={`/leads/${lead.id}`}
                      className="font-medium text-ink hover:text-brand focus-ring"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {truncate(lead.job_title ?? "[untitled job]", 68)}
                    </Link>
                    <div className="text-xs text-muted">
                      {lead.job_id ? `#${lead.job_id}` : "no job id"}
                      {lead.job_location ? ` · ${lead.job_location}` : ""}
                    </div>
                  </Td>
                  <Td className="text-muted">
                    {lead.client_name ?? "—"}
                    <div className="text-xs text-muted/70">
                      {lead.company_mentioned ?? lead.client_location ?? "—"}
                    </div>
                  </Td>
                  <Td>
                    <ConfidenceBadge value={lead.overall_confidence} />
                  </Td>
                  <Td>
                    <PipelineChips lead={lead} />
                  </Td>
                  <Td>
                    <StatusBadge status={lead.status} />
                  </Td>
                  <Td className="text-xs text-muted">
                    <TimeAgo value={lead.received_at} />
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </div>

      <Pager
        page={meta?.page ?? 1}
        totalPages={meta?.totalPages ?? 1}
        total={meta?.total ?? 0}
        onChange={(page) => setParam("page", page > 1 ? String(page) : undefined)}
      />
    </div>
  );
}

function Pager({
  page,
  totalPages,
  total,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-between text-sm text-muted">
      <span className="tabular">
        {total} leads · page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Prev
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

/** Four dots = the pipeline at a glance: text, channel, document, delivery. */
function PipelineChips({ lead }: { lead: LeadSummary }) {
  const stages = [
    {
      key: "post",
      on: Boolean(lead.job_description?.trim() || lead.job_title?.trim()),
      label: lead.job_description?.trim()
        ? `${lead.job_description.trim().length} chars of post text`
        : "no post text",
    },
    { key: "channel", on: (lead.contact_count ?? 0) > 0, label: `${lead.contact_count ?? 0} channel(s) found` },
    {
      key: "doc",
      on: ["enriched", "proposal_ready", "draft_created", "sent"].includes(lead.status),
      label: "document written",
    },
    { key: "sent", on: lead.status === "sent", label: "email delivered" },
  ];

  return (
    <span className="flex items-center gap-1" title={stages.map((s) => `${s.label}${s.on ? " ✓" : " ✗"}`).join("\n")}>
      {stages.map((stage) => (
        <span
          key={stage.key}
          className={cn(
            "h-1.5 w-5 rounded-full",
            stage.on ? "bg-brand" : "bg-surface-2 border border-line",
          )}
        />
      ))}
    </span>
  );
}

export function ConfidenceBadge({ value }: { value: string }) {
  const tone =
    value === "HIGH" ? "brand" : value === "MEDIUM" ? "warn" : value === "LOW" ? "neutral" : "neutral";
  return (
    <Badge tone={tone as "brand" | "warn" | "neutral"} className={cn(value === "UNIDENTIFIED" && "opacity-70")}>
      {value}
    </Badge>
  );
}
