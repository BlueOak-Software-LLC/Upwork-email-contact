"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useLeads } from "@/lib/api/outreach-hooks";
import { Button } from "@/components/ui/button";
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
        <Button variant="ghost" size="sm" onClick={() => refetch()} loading={isFetching}>
          Refresh
        </Button>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={8} />
        ) : error ? (
          <div className="p-6 text-sm text-danger">
            {(error as Error).message}
            <p className="mt-2 text-xs text-muted">
              POST a payload to <code>/api/leads</code> first, or apply the 0002 migration.
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted">
            No leads yet —{" "}
            <code>POST {`{ "job_information": … }`}</code> to{" "}
            <code>/api/leads</code> and they appear here.
          </div>
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>Job</Th>
                <Th>Client / company</Th>
                <Th>Confidence</Th>
                <Th>Channels</Th>
                <Th>Status</Th>
                <Th>Received</Th>
              </Tr>
            </THead>
            <TBody>
              {rows.map((lead) => (
                <Tr key={lead.id}>
                  <Td className="max-w-sm">
                    <Link
                      href={`/leads/${lead.id}`}
                      className="font-medium text-ink hover:text-brand focus-ring"
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
                  <Td className="tabular text-muted">
                    {(lead.contact_count ?? 0) > 0 ? (
                      <span>{lead.contact_count} found</span>
                    ) : (
                      <span className="text-muted/60">—</span>
                    )}
                  </Td>
                  <Td>
                    <StatusBadge status={lead.status} />
                  </Td>
                  <Td className="tabular text-xs text-muted">
                    {new Date(lead.received_at).toLocaleDateString()}
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

export function ConfidenceBadge({ value }: { value: string }) {
  const tone =
    value === "HIGH" ? "brand" : value === "MEDIUM" ? "warn" : value === "LOW" ? "neutral" : "neutral";
  return (
    <Badge tone={tone as "brand" | "warn" | "neutral"} className={cn(value === "UNIDENTIFIED" && "opacity-70")}>
      {value}
    </Badge>
  );
}
