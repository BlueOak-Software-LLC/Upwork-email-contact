"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useLeads, type LeadSummary } from "@/lib/api/outreach-hooks";
import { IngestDialog } from "./ingest-dialog";
import { DeleteLeadsDialog } from "./delete-leads-dialog";
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
  const rows = useMemo(() => data?.data ?? [], [data]);
  const meta = data?.meta;
  const [ingestOpen, setIngestOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<LeadSummary[] | null>(null);
  const headCheck = useRef<HTMLInputElement>(null);

  const selectedRows = useMemo(
    () => rows.filter((row) => selected.has(row.id)),
    [rows, selected],
  );
  const selectionTotals = selectedRows.reduce(
    (acc, row) => ({
      proposals: acc.proposals + (row.proposal_count ?? 0),
      drafts: acc.drafts + (row.draft_count ?? 0),
      contacts: acc.contacts + (row.contact_count ?? 0),
    }),
    { proposals: 0, drafts: 0, contacts: 0 },
  );

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The header box needs the indeterminate state set imperatively — there is no
  // attribute for it, and a half-selected page should not look "all off".
  useEffect(() => {
    if (!headCheck.current) return;
    headCheck.current.checked = rows.length > 0 && selectedRows.length === rows.length;
    headCheck.current.indeterminate = selectedRows.length > 0 && selectedRows.length < rows.length;
  }, [rows, selectedRows]);

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

      <DeleteLeadsDialog
        open={Boolean(pendingDelete)}
        leads={pendingDelete ?? []}
        onClose={() => setPendingDelete(null)}
        onRemoved={(ids) =>
          setSelected((current) => {
            const next = new Set(current);
            for (const id of ids) next.delete(id);
            return next;
          })
        }
      />

      {selected.size > 0 ? (
        <div
          className="animate-pop-in flex flex-wrap items-center gap-2 rounded-xl border border-danger/45 bg-danger/10 px-3 py-2 text-sm"
          role="region"
          aria-label="Selection"
        >
          <b className="tabular">{selected.size} selected</b>
          <span className="text-xs text-muted tabular">
            {selectionTotals.proposals} document(s) · {selectionTotals.drafts} draft(s) ·{" "}
            {selectionTotals.contacts} contact channel(s)
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button size="sm" variant="danger" onClick={() => setPendingDelete(selectedRows)}>
              Remove from list and database
            </Button>
          </div>
        </div>
      ) : null}

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
                <Th className="w-9 pr-0">
                  <input
                    ref={headCheck}
                    type="checkbox"
                    aria-label={
                      rows.length ? `Select all ${rows.length} leads on this page` : "Select all leads"
                    }
                    className="h-3.5 w-3.5 accent-danger"
                    onChange={(event) =>
                      setSelected(event.target.checked ? new Set(rows.map((row) => row.id)) : new Set())
                    }
                  />
                </Th>
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
                  className={cn(
                    "group cursor-pointer transition hover:bg-surface-2/60",
                    // Selection here means "about to be removed", so the accent
                    // matches the toolbar instead of the success colour.
                    selected.has(lead.id) &&
                      "bg-danger/5 shadow-[inset_2px_0_0_var(--color-danger)]",
                  )}
                >
                  <Td className="w-9 pr-0" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(lead.id)}
                      onChange={() => toggle(lead.id)}
                      aria-label={`Select ${lead.job_title ?? "untitled job"}`}
                      className="h-3.5 w-3.5 accent-danger"
                    />
                  </Td>
                  <Td className="max-w-sm">
                    <Link
                      href={`/leads/${lead.id}`}
                      className="font-medium text-ink hover:text-brand focus-ring"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {truncate(lead.job_title ?? "[untitled job]", 68)}
                    </Link>
                    <div className="truncate text-xs text-faint">
                      {lead.job_id ? `#${lead.job_id}` : "no job id"}
                      {lead.job_location ? ` · ${truncate(lead.job_location, 72)}` : ""}
                    </div>
                  </Td>
                  <Td className="max-w-[16rem] text-muted">
                    <div className="truncate">{lead.client_name ?? "—"}</div>
                    <div className="truncate text-xs text-faint">
                      {truncate(lead.company_mentioned ?? lead.client_location ?? "—", 58)}
                    </div>
                  </Td>
                  <Td>
                    <ConfidenceBadge value={lead.overall_confidence} />
                  </Td>
                  <Td>
                    <PipelineChips lead={lead} />
                    {lead.proposal_count || lead.draft_count ? (
                      <div className="mt-1 font-mono text-[10px] text-faint">
                        {lead.proposal_count ?? 0} doc · {lead.draft_count ?? 0} draft
                      </div>
                    ) : null}
                  </Td>
                  <Td>
                    <StatusBadge status={lead.status} />
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-muted">
                    <TimeAgo value={lead.received_at} />
                  </Td>
                  <Td className="w-10 text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${lead.job_title ?? "untitled job"} permanently`}
                      title="Remove this job and everything generated from it"
                      onClick={(event) => {
                        event.stopPropagation();
                        setPendingDelete([lead]);
                      }}
                      className="text-muted/70 opacity-0 transition group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                    >
                      ✕
                    </Button>
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
      // Only the count tells the truth now that ingest no longer writes a
      // document: `status` reaches `enriched` as soon as a contact exists.
      on: (lead.proposal_count ?? 0) > 0,
      label:
        (lead.proposal_count ?? 0) > 0
          ? `${lead.proposal_count} document version(s) written`
          : "no document yet — open the lead and click Generate PPD",
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
