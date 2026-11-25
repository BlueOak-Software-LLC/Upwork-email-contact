import "server-only";
import { getServerEnv } from "@/lib/env";

/**
 * Fallback identity for a fresh install with no sender profile yet. The real
 * name, role and contact details come from `sender_accounts`; this function
 * deliberately never invents a company name.
 */
export function brandConfig() {
  const env = getServerEnv();
  const from = parseFrom(env.EMAIL_FROM);
  // `PROPOSAL_COMPANY` is parsed for old .env files but is deliberately never
  // returned: no company name may reach a PPD, PDF or email signature.
  const company = "";
  // Only the explicit name is safe here: an EMAIL_FROM display name can be a
  // company, and the PPD must never print one.
  const preparedBy = env.PROPOSAL_PREPARED_BY || "";
  const title = env.PROPOSAL_TITLE;
  return {
    company,
    website: env.PROPOSAL_WEBSITE,
    preparedBy,
    title,
    /** What the PDF and the document print: "Luan Le · Senior Software Engineer". */
    preparedLine: [preparedBy, title].filter(Boolean).join(" · "),
    senderEmail: from.email || env.EMAIL_FROM,
    phone: "",
    whatsapp: "",
    linkedin: "",
    location: "",
    experience: "",
    skills: "",
    rate: env.PROPOSAL_RATE,
    /** Canonical plain-text email sign-off. Appended server-side, never by the model. */
    signature: signatureLines({
      website: env.PROPOSAL_WEBSITE,
      preparedBy,
      title,
      email: from.email || env.EMAIL_FROM,
    }),
  };
}

/**
 * The sign-off block, so the writer's name, role, email and site are ours on
 * every message even when the model invents something else.
 */
function signatureLines(brand: {
  website: string;
  preparedBy: string;
  title: string;
  email: string;
}): string[] {
  const lines = ["Best regards,"];
  if (brand.preparedBy) lines.push(brand.preparedBy);
  if (brand.title) lines.push(brand.title);
  const contact = [brand.email, brand.website].filter(Boolean).join(" · ");
  if (contact) lines.push(contact);
  return lines;
}

/** `"Luan Le" <luan@example.com>` → { email, local, domain }. */
function parseFrom(value: string) {
  const match = /^(?:"[^"]+"|[^<]+)?\s*<([^>]+)>$/.exec(value.trim());
  const email = (match?.[1] ?? value).trim();
  const [local = "", domain = ""] = email.split("@");
  return {
    email: email.includes("@") ? email : "",
    local,
    domain,
  };
}


export function pdfConfig() {
  const env = getServerEnv();
  return {
    provider: env.PDF_PROVIDER,
    /**
     * Reference copy of one compiled document (import it into the PDFme
     * Designer to re-style). Runtime templates are generated per proposal by
     * `lib/pdfme/compiler.ts`.
     */
    templatePath: env.PDFME_TEMPLATE_PATH,
  };
}
