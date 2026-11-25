"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { LEAD_DATE_RANGES, leadDateRange, type LeadDateRangeKey } from "@/lib/date-ranges";
import { paginationItems } from "@/lib/pagination";
import type { LeadPipeline } from "@/types/lead";

const PIPELINE_OPTIONS: Array<{ value: LeadPipeline; label: string }> = [
  { value: "sent", label: "Email sent" },
  { value: "both", label: "Doc/Draft both ready" },
  { value: "doc", label: "Doc ready (no draft)" },
  { value: "draft", label: "Draft ready (no doc)" },
];

const SORT_OPTIONS = [
  { value: "created_at:desc", label: "Newest first" },
  { value: "created_at:asc", label: "Oldest first" },
  { value: "updated_at:desc", label: "Recently updated" },
  { value: "job_title:asc", label: "Job title A-Z" },
  { value: "status:asc", label: "Status" },
  { value: "overall_confidence:desc", label: "Confidence" },
] as const;

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
  const pageParam = Number(params.get("page") ?? 1);
  const filters = useMemo(
    () => ({
      q: params.get("q") ?? undefined,
      status: params.get("status") ?? undefined,
      pipeline: params.get("pipeline") ?? undefined,
      confidence: params.get("confidence") ?? undefined,
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
      sort: params.get("sort") ?? "created_at",
      order: params.get("order") ?? "desc",
      page: Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1,
      pageSize: 25,
    }),
    [params, pageParam],
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

  const setParams = (updates: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    next.delete("page");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };

  const setParam = (key: string, value: string | undefined) => setParams({ [key]: value });

  const goToPage = useCallback(
    (page: number) => {
      const next = new URLSearchParams(params.toString());
      if (page > 1) next.set("page", String(page));
      else next.delete("page");
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    },
    [params, pathname, router],
  );

  // A bookmarked ?page=99 is answered with the last real page. Rewrite the URL
  // to match so the next filter change does not carry the stale page number.
  useEffect(() => {
    if (meta && meta.page !== filters.page) goToPage(meta.page);
  }, [meta, filters.page, goToPage]);

  const dateSelection =
    params.get("range") ?? (params.get("from") || params.get("to") ? "custom" : "all");

  const applyDateRange = (value: string) => {
    if (value === "all") {
      setParams({ range: undefined, from: undefined, to: undefined });
      return;
    }
    if (value === "custom") return;
    const range = leadDateRange(value as LeadDateRangeKey);
    if (!range) return;
    setParams({ range: value, from: range.from, to: range.to });
  };

  const sortValue = `${params.get("sort") ?? "created_at"}:${params.get("order") ?? "desc"}`;
  const applySort = (value: string) => {
    const [sort, order] = value.split(":");
    setParams({ sort, order });
  };

  const hasFilters = Boolean(
    params.get("q") ||
      params.get("status") ||
      params.get("pipeline") ||
      params.get("confidence") ||
      params.get("from") ||
      params.get("to"),
  );

  return (
    <div className="space-y-4">
      <div className="card space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setParam("q", search.trim() || undefined);
            }}
          >
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search job title, company, client…"
              className="max-w-sm"
              aria-label="Search leads"
            />
            <Button type="submit" variant="secondary" size="sm">
              Search
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

        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Created date"
            className="w-40"
            value={dateSelection}
            onChange={(e) => applyDateRange(e.target.value)}
          >
            <option value="all">Any date</option>
            {dateSelection === "custom" ? <option value="custom">Custom range</option> : null}
            {LEAD_DATE_RANGES.map((range) => (
              <option key={range.value} value={range.value}>
                {range.label}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Pipeline status"
            className="w-48"
            value={params.get("pipeline") ?? ""}
            onChange={(e) => setParam("pipeline", e.target.value || undefined)}
          >
            <option value="">Any pipeline state</option>
            {PIPELINE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
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
          <Select
            aria-label="Sort leads"
            className="w-44"
            value={sortValue}
            onChange={(e) => applySort(e.target.value)}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          {hasFilters ? (
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
            title={hasFilters ? "Nothing matches these filters" : "No leads yet"}
            description={
              hasFilters ? (
                <>
                  Search covers the title, company, client, industry and the whole post body. Try a
                  wider date range or clear the pipeline filter.
                </>
              ) : (
                <>
                  Every object posted to <code>POST /api/leads</code> lands here. Paste one now, or
                  point your scraper at the endpoint.
                </>
              )
            }
            action={
              <>
                {hasFilters ? (
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
                <Th>Created</Th>
                <Th className="w-10">
                  <span className="sr-only">Actions</span>
                </Th>
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
                    <TimeAgo value={lead.created_at} />
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
        pageSize={meta?.pageSize ?? 25}
        onChange={goToPage}
      />
    </div>
  );
}

function Pager({
  page,
  totalPages,
  total,
  pageSize,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, totalPages);
  const current = Math.min(Math.max(1, page), pages);
  const first = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const last = Math.min(current * pageSize, total);

  return (
    <div className="flex flex-col gap-3 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
      <span className="tabular">
        {total === 0 ? "No leads" : `${first}–${last} of ${total}`} · page {current} of {pages}
      </span>
      <nav aria-label="Lead pages" className="flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          variant="secondary"
          disabled={current <= 1}
          onClick={() => onChange(current - 1)}
        >
          Prev
        </Button>
        {paginationItems(current, pages).map((item, index) =>
          item === "ellipsis" ? (
            <span key={`gap-${index}`} className="px-1 text-faint" aria-hidden>
              …
            </span>
          ) : (
            <Button
              key={item}
              size="sm"
              variant={item === current ? "primary" : "secondary"}
              className="min-w-8 px-2"
              aria-current={item === current ? "page" : undefined}
              aria-label={`Page ${item}`}
              onClick={() => onChange(item)}
            >
              {item}
            </Button>
          ),
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={current >= pages}
          onClick={() => onChange(current + 1)}
        >
          Next
        </Button>
      </nav>
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
