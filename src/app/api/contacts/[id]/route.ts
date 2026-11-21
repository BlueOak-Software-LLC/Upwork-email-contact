import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { noContent, ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { contactsRepo } from "@/server/db/contacts.repo";
import { updateContactSchema } from "@/lib/validation/contact";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function readJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    throw ApiError.badRequest("Body must be valid JSON");
  }
}

/** GET /api/contacts/:id */
export const GET = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  return ok({ contact: await contactsRepo.byId(id) });
});

/** PATCH /api/contacts/:id — partial update (status changes, notes, tags…). */
export const PATCH = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  const patch = parseOrThrow(updateContactSchema, await readJson(request));
  return ok({ contact: await contactsRepo.update(id, patch) });
});

/** DELETE /api/contacts/:id */
export const DELETE = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  await contactsRepo.remove(id);
  return noContent();
});
