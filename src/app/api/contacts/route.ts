import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { created, paged, withRevalidation } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { contactsRepo } from "@/server/db/contacts.repo";
import {
  createContactSchema,
  listContactsQuerySchema,
} from "@/lib/validation/contact";

export const dynamic = "force-dynamic";

async function readJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    throw ApiError.badRequest("Body must be valid JSON");
  }
}

/**
 * API #1 — GET /api/contacts
 * The contacts table as JSON, for the dashboard and any external client.
 *
 * Query: ?q=&status=&source=&tag=&page=&pageSize=&sort=&order=
 * Auth : `x-api-key` (when API_MASTER_KEY is set) or a Supabase session cookie.
 */
export const GET = withApi(async (request) => {
  await requireApiKey(request);

  const query = parseOrThrow(
    listContactsQuerySchema,
    Object.fromEntries(request.nextUrl.searchParams),
  );

  const result = await contactsRepo.list(query);
  return paged(result, withRevalidation(15));
});

/** POST /api/contacts — insert a contact. */
export const POST = withApi(async (request) => {
  await requireApiKey(request);
  const input = parseOrThrow(createContactSchema, await readJson(request));
  const contact = await contactsRepo.create(input);
  return created({ contact });
});
