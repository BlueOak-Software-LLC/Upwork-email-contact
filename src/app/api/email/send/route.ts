import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { created, ok } from "@/server/http/responses";
import { clientIp, requireApiKey } from "@/server/http/auth";
import { rateLimit } from "@/server/http/rate-limit";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { sendEmailSchema } from "@/lib/validation/email";
import { sendEmail } from "@/server/services/email.service";
import { getServerEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

async function readJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    throw ApiError.badRequest("Body must be valid JSON");
  }
}

/**
 * API #2 — POST /api/email/send
 * Deliver an email through the configured provider (resend | smtp | log) and
 * write one `email_logs` row per recipient. Optionally stamps the contact.
 *
 * {
 *   "to": "client@example.com" | ["a@x.com", "b@y.com"],
 *   "cc": ["boss@x.com"],
 *   "subject": "Quick question about your listing",
 *   "text": "Hi ...",                       // html is generated if omitted
 *   "html": "<p>Hi …</p>",                  // optional override
 *   "contactId": "uuid",                    // optional
 *   "updateContact": true,                  // default true
 *   "replyTo": "me@x.com",                  // optional
 *   "headers": { "List-Unsubscribe": "<https://…>" }
 * }
 */
export const POST = withApi(async (request: NextRequest) => {
  const auth = await requireApiKey(request);
  const payload = parseOrThrow(sendEmailSchema, await readJson(request));

  // 10 sends / minute per credential, 30 / minute per IP (single-instance guard).
  const scope = auth.kind === "service" ? "api-key" : auth.kind === "user" ? auth.id : clientIp(request);
  rateLimit(`email:${scope}`, 10, 60_000);
  rateLimit(`email:ip:${clientIp(request)}`, 30, 60_000);

  const results = await sendEmail(payload);
  const sent = results.filter((r) => r.status === "sent");
  const failed = results.filter((r) => r.status === "failed");

  const body = {
    provider: results[0]?.provider ?? getServerEnv().EMAIL_PROVIDER,
    requested: results.length,
    delivered: sent.length,
    failed: failed.length,
    results,
  };

  return failed.length === 0
    ? created({ ...body, message: "Email queued for delivery" })
    : ok({ ...body, message: "Partial delivery — check `results`" });
});
