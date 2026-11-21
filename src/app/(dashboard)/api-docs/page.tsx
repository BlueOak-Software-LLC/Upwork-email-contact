import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";
export const metadata = { title: "API" };

const ENDPOINTS = [
  {
    method: "GET",
    path: "/api/contacts",
    title: "API #1 — contacts as JSON",
    query: "q, status, source, tag, page, pageSize, sort, order",
    sample: `curl -s $APP_URL/api/contacts?status=new\\&pageSize=5 \\
  -H "x-api-key: $API_MASTER_KEY"`,
    response: `{
  "data": [
    { "id": "uuid", "name": "Jane", "email": "jane@acme.co",
      "status": "new", "last_contacted_at": null, ... }
  ],
  "meta": { "page": 1, "pageSize": 5, "total": 128, "totalPages": 26 }
}`,
  },
  {
    method: "POST",
    path: "/api/email/send",
    title: "API #2 — send an email",
    query: "JSON body: to, cc, subject, text|html, contactId, updateContact",
    sample: `curl -s -X POST $APP_URL/api/email/send \\
  -H "content-type: application/json" \\
  -H "x-api-key: $API_MASTER_KEY" \\
  -d '{
    "to": "client@acme.co",
    "subject": "Quick question about your project",
    "text": "Hi Jane, are you free for a 15-min call?",
    "contactId": "0f0f...uuid"
  }'`,
    response: `{
  "data": {
    "provider": "resend", "requested": 1, "delivered": 1, "failed": 0,
    "results": [{ "id": "log-uuid", "status": "sent",
                  "providerMessageId": "…", "to": "client@acme.co" }]
  }
}`,
  },
  {
    method: "GET",
    path: "/api/email",
    title: "Delivery history",
    query: "page, pageSize, status, to",
    sample: `curl -s $APP_URL/api/email?status=failed -H "x-api-key: $API_MASTER_KEY"`,
    response: `{ "data": [ … ], "meta": { … } }`,
  },
  {
    method: "GET",
    path: "/api/health",
    title: "Liveness + Supabase probe",
    query: "—",
    sample: `curl -s $APP_URL/api/health`,
    response: `{ "data": { "status": "ok", "emailProvider": "resend",
  "checks": { "supabase": { "ok": true } } } }`,
  },
] as const;

export default function ApiDocsPage() {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-medium text-muted">Backend API</h2>
        <p className="text-xs text-muted/80">
          Route Handlers under <code>src/app/api/**</code> — the same code runs on Vercel
          serverless functions. Errors always return{" "}
          <code>{`{ "error": { "code", "message", "details?" } }`}</code>.
        </p>
      </div>

      {ENDPOINTS.map((ep) => (
        <section key={ep.path + ep.method} className="card space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={ep.method === "GET" ? "brand" : "warn"}>{ep.method}</Badge>
            <code className="text-sm font-medium">{ep.path}</code>
            <span className="ml-auto text-xs text-muted">{ep.title}</span>
          </div>
          <p className="text-xs text-muted">
            <span className="text-muted/70">params:</span> {ep.query}
          </p>
          <pre className="overflow-x-auto rounded-lg bg-canvas p-3 text-xs leading-relaxed text-muted">
            {ep.sample}
          </pre>
          <pre className="overflow-x-auto rounded-lg bg-canvas p-3 text-xs leading-relaxed text-muted/80">
            {ep.response}
          </pre>
        </section>
      ))}
    </div>
  );
}
