import { emailLogsRepo } from "@/server/db/email-logs.repo";
import { StatusBadge } from "@/components/ui/badge";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { formatDate, truncate } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Email log" };

export default async function EmailsPage() {
  const logs = await emailLogsRepo
    .list({ page: 1, pageSize: 50 })
    .catch(() => null);

  if (!logs) {
    return (
      <div className="card p-6 text-sm text-muted">
        Could not read <code>public.email_logs</code>. Apply the migration and set the
        Supabase env vars, then refresh.
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
          <p className="p-10 text-center text-sm text-muted">
            Nothing sent yet — POST to <code>/api/email/send</code> and rows land here.
          </p>
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
                  <Td className="font-medium">{log.to_email}</Td>
                  <Td className="text-muted">{truncate(log.subject, 48)}</Td>
                  <Td className="max-w-xs truncate text-xs text-muted/80">
                    {truncate(log.body_text ?? "", 90)}
                    {log.error ? (
                      <span className="ml-2 text-danger">{truncate(log.error, 60)}</span>
                    ) : null}
                  </Td>
                  <Td className="text-muted">
                    {log.provider}
                    <div className="text-[11px] text-muted/60">
                      {log.provider_message_id ? truncate(log.provider_message_id, 24) : "—"}
                    </div>
                  </Td>
                  <Td className="tabular text-muted">{formatDate(log.created_at)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </div>
  );
}
