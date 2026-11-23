import { emailLogsRepo } from "@/server/db/email-logs.repo";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { CopyButton } from "@/components/ui/copy-button";
import { TimeAgo } from "@/components/ui/time-ago";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { truncate } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Email log" };

export default async function EmailsPage() {
  const logs = await emailLogsRepo
    .list({ page: 1, pageSize: 50 })
    .catch(() => null);

  if (!logs) {
    return (
      <div className="card">
        <EmptyState
          tone="danger"
          icon="✕"
          title="public.email_logs could not be read"
          description="Apply the migrations and set the Supabase env vars, then reload — this page re-runs the query on focus."
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-muted">Delivery log</h2>
          <p className="text-xs text-muted/80">
            Every <code>POST /api/email/send</code> writes one row per recipient.
          </p>
        </div>
        <span className="text-xs text-muted tabular">
          {logs.total} total · showing {logs.items.length}
        </span>
      </div>

      <div className="card overflow-hidden">
        {logs.items.length === 0 ? (
          <EmptyState
            title="Nothing sent yet"
            description={
              <>
                Every <code>POST /api/email/send</code> and every draft send writes one row per
                recipient here, with provider, message id and error text.
              </>
            }
            action={
              <Link href="/leads" className="text-xs text-brand hover:underline">
                Go to a lead and send a draft →
              </Link>
            }
          />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>Status</Th>
                <Th>To</Th>
                <Th>Subject</Th>
                <Th>Body</Th>
                <Th>Provider</Th>
                <Th>When</Th>
              </Tr>
            </THead>
            <TBody>
              {logs.items.map((log) => (
                <Tr key={log.id}>
                  <Td>
                    <StatusBadge status={log.status} />
                  </Td>
                  <Td className="font-medium">
                    <span className="flex items-center gap-1.5">
                      {log.to_email}
                      <CopyButton value={log.to_email} size="icon" label="Copy recipient" />
                    </span>
                    {log.draft_id ? (
                      <div className="text-[11px] font-normal text-muted/70">
                        draft {String(log.draft_id).slice(0, 8)}
                      </div>
                    ) : null}
                  </Td>
                  <Td className="text-muted">{truncate(log.subject, 48)}</Td>
                  <Td className="max-w-xs text-xs text-muted/80">
                    <details>
                      <summary className="cursor-pointer list-none truncate">
                        {truncate(log.body_text ?? "", 90)}
                      </summary>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-canvas p-2 font-sans text-[11px] text-ink/80">
                        {log.body_text}
                      </pre>
                    </details>
                    {log.error ? (
                      <div className="mt-1 text-danger">{truncate(log.error, 90)}</div>
                    ) : null}
                  </Td>
                  <Td className="text-muted">
                    {log.provider === "log" ? (
                      <span className="rounded bg-warn/12 px-1.5 py-0.5 text-[11px] text-warn">
                        log only (dry run)
                      </span>
                    ) : (
                      log.provider
                    )}
                    <div className="text-[11px] text-muted/60">
                      {log.provider_message_id ? truncate(log.provider_message_id, 24) : "—"}
                    </div>
                  </Td>
                  <Td className="text-xs text-muted">
                    <TimeAgo value={log.created_at} />
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </div>
  );
}
