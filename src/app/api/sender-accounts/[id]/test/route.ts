import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { verifySmtpAccount } from "@/server/services/smtp.service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Route params: `withApi<P>` wraps P as `{ params: Promise<P> }`. */
type Ctx = { id: string };

/**
 * POST /api/sender-accounts/:id/test
 * Runs nodemailer `transport.verify()` — authenticates against the stored SMTP
 * host/port/user/password without sending anything, and records the outcome on
 * the account (`status`, `last_verified_at`, `last_error`).
 */
export const POST = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  return ok(await verifySmtpAccount(id));
});
