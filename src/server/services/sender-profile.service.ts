import { brandConfig } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import {
  senderAccountsRepo,
  type SenderAccountDto,
} from "@/server/db/sender-accounts.repo";
import type { ProposalBrand } from "@/server/services/prompts/proposal.prompt";
import { emailSignatureLines } from "@/lib/email-signature";

/**
 * The identity stamped onto a PPD, the PDF header and every email sign-off.
 *
 * It comes from a `sender_accounts` row (Settings → Senders & profile), not
 * from a model and not from a company env var. A proposal is written by a
 * person; the server must be able to prove every name, number and link on it.
 * Environment values remain only as a fallback for a fresh install with no
 * sender profile yet.
 */
export function brandFromSender(account: SenderAccountDto | null): ProposalBrand {
  const env = brandConfig();
  const preparedBy = account?.display_name?.trim() || env.preparedBy;
  const title = account?.role_title?.trim() || env.title;
  const company = account?.company_name?.trim() || env.company;
  const senderEmail = account?.from_email?.trim() || env.senderEmail;
  const website = account?.website?.trim() || env.website;
  const phone = account?.phone?.trim() || "";
  const whatsapp = account?.whatsapp?.trim() || "";
  const linkedin = account?.linkedin_url?.trim() || "";
  const location = account?.location?.trim() || "";
  const experience = account?.experience_summary?.trim() || "";
  const skills = account?.skills?.trim() || "";
  const signature = emailSignatureLines({
    name: preparedBy,
    role: title,
    company,
    website,
  });

  return {
    company,
    website,
    preparedBy,
    title,
    preparedLine: [preparedBy, title].filter(Boolean).join(" · "),
    senderEmail,
    phone,
    whatsapp,
    linkedin,
    location,
    experience,
    skills,
    rate: env.rate,
    signature,
  };
}

/**
 * Resolve the profile for a job. An explicit id must exist; without one we use
 * the default active mailbox, then the oldest active one, then env fallback.
 */
export async function resolveSenderBrand(senderAccountId?: string | null): Promise<ProposalBrand> {
  if (senderAccountId) {
    return brandFromSender(await senderAccountsRepo.getPublic(senderAccountId));
  }
  try {
    const id = await senderAccountsRepo.defaultAccountId();
    return brandFromSender(id ? await senderAccountsRepo.getPublic(id) : null);
  } catch (error) {
    logger.warn("sender_profile_fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
    return brandFromSender(null);
  }
}
