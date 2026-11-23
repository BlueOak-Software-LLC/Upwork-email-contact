import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { created, ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { createSenderAccountSchema } from "@/lib/validation/outreach";
import { senderAccountsRepo } from "@/server/db/sender-accounts.repo";

export const dynamic = "force-dynamic";

async function readJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    throw ApiError.badRequest("Body must be valid JSON");
  }
}

/**
 * GET /api/sender-accounts
 * Our sending mailboxes. The SMTP password is never returned — only
 * `has_password` / `password_mask`.
 */
export const GET = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  return ok({ accounts: await senderAccountsRepo.list() });
});

/**
 * POST /api/sender-accounts
 * Add one of our two email addresses + its SMTP server.
 *
 * {
 *   "label": "Studio Gmail",
 *   "fromEmail": "hello@yourdomain.com",
 *   "displayName": "Your Studio",
 *   "smtpHost": "smtp.gmail.com", "smtpPort": 465, "smtpSecure": true,
 *   "smtpUser": "hello@yourdomain.com", "smtpPassword": "app password",
 *   "dailyLimit": 50, "isDefault": true
 * }
 *
 * `smtpPassword` is AES-256-GCM encrypted (APP_ENCRYPTION_KEY) before it is
 * written to Postgres.
 */
export const POST = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  const input = parseOrThrow(createSenderAccountSchema, await readJson(request));

  const account = await senderAccountsRepo.create({
    label: input.label,
    fromEmail: input.fromEmail,
    displayName: input.displayName ?? null,
    replyTo: input.replyTo ?? null,
    signature: input.signature ?? null,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    smtpUser: input.smtpUser ?? null,
    smtpPassword: input.smtpPassword,
    dailyLimit: input.dailyLimit,
    isDefault: input.isDefault,
  });

  return created({ account });
});
