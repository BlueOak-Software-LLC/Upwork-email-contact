import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { noContent, ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { updateSenderAccountSchema } from "@/lib/validation/outreach";
import { senderAccountsRepo } from "@/server/db/sender-accounts.repo";

export const dynamic = "force-dynamic";

/** Route params: `withApi<P>` wraps P as `{ params: Promise<P> }`. */
type Ctx = { id: string };

async function readJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    throw ApiError.badRequest("Body must be valid JSON");
  }
}

/** GET /api/sender-accounts/:id */
export const GET = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  return ok({ account: await senderAccountsRepo.getPublic(id) });
});

/** PATCH /api/sender-accounts/:id — omit `smtpPassword` to keep the stored one. */
export const PATCH = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  const input = parseOrThrow(updateSenderAccountSchema, await readJson(request));

  const account = await senderAccountsRepo.update(id, {
    label: input.label,
    fromEmail: input.fromEmail,
    displayName: input.displayName,
    replyTo: input.replyTo,
    signature: input.signature,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    smtpUser: input.smtpUser,
    smtpPassword: input.smtpPassword,
    dailyLimit: input.dailyLimit,
    isDefault: input.isDefault,
  });

  return ok({ account });
});

/** DELETE /api/sender-accounts/:id */
export const DELETE = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  await senderAccountsRepo.remove(id);
  return noContent();
});
