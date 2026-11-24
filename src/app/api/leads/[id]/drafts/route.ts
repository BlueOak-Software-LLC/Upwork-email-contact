import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { created, ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { manualDraftSchema } from "@/lib/validation/outreach";
import { draftsRepo, proposalsRepo } from "@/server/db/outreach.repo";
import { leadsRepo } from "@/server/db/leads.repo";
import { textToHtml } from "@/server/services/templates";
import { requireParamId } from "@/server/http/id";

export const dynamic = "force-dynamic";

/** Route params: `withApi<P>` wraps P as `{ params: Promise<P> }`. */
type Ctx = { id: string };

async function readJson(request: NextRequest) {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw ApiError.badRequest("Body must be valid JSON");
  }
}

/** GET /api/leads/:id/drafts — every draft on the lead. */
export const GET = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "lead id");
  return ok({ drafts: await leadsRepo.drafts(id) });
});

/**
 * POST /api/leads/:id/drafts — write it yourself.
 *
 * No model call at all: this is the escape hatch for a custom email to a custom
 * address (the recipient does not have to come from the payload). The PDF is
 * still rendered from the reviewed PPD at send time when `proposalId` is set.
 *
 * { "toEmail": "client@example.com", "cc": ["boss@example.com"],
 *   "subject": "…", "bodyText": "…", "proposalId": "uuid|null",
 *   "senderAccountId": "uuid|null" }
 */
export const POST = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "lead id");
  const input = parseOrThrow(manualDraftSchema, await readJson(request));

  const recipient = input.toEmail.trim().toLowerCase();
  const { row: contact } = await leadsRepo.upsertManualContact(id, recipient);

  const proposalId = input.proposalId ?? null;
  if (proposalId) await proposalsRepo.byId(proposalId); // fails loudly if it's gone

  const draft = await draftsRepo.create({
    leadId: id,
    leadContactId: contact.id,
    proposalId,
    senderAccountId: input.senderAccountId ?? null,
    toEmail: recipient,
    cc: input.cc ?? null,
    subject: input.subject,
    bodyText: input.bodyText,
    bodyHtml: textToHtml(input.bodyText),
    attachments: [],
    status: "draft",
    recipientSource: "custom",
  });

  const lead = await leadsRepo.byId(id);
  if (lead.status !== "sent") await leadsRepo.setStatus(id, "draft_created");

  return created({ draft, recipient: { email: recipient, contactId: contact.id, source: "custom" } });
});
