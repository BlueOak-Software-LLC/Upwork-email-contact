import "server-only";
import { getServerEnv } from "@/lib/env";
import { emailSignatureLines } from "@/lib/email-signature";

/**
 * Fallback identity for a fresh install with no sender profile yet. The real
 * name, role and contact details come from `sender_accounts`; this function
 * deliberately never invents a company name; an explicitly configured env
 * value is used only for the linked email-signature label.
 */
export function brandConfig() {
  const env = getServerEnv();
  const from = parseFrom(env.EMAIL_FROM);
  // This value may label the linked company website in an email signature;
  // PPD identity is still derived from the sender profile's person fields.
  const company = env.PROPOSAL_COMPANY;
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
      company,
    }),
  };
}

/** Keep email-signature formatting consistent with selected sender profiles. */
function signatureLines(brand: {
  website: string;
  preparedBy: string;
  title: string;
  company: string;
}): string[] {
  return emailSignatureLines({
    name: brand.preparedBy,
    role: brand.title,
    company: brand.company,
    website: brand.website,
  });
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
