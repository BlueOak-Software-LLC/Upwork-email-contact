export interface EmailSignatureProfile {
  name?: string | null;
  role?: string | null;
  company?: string | null;
  website?: string | null;
}

const WHATSAPP_URL = "https://wa.me/84366425800";

export function whatsappStartUrl(): string {
  return WHATSAPP_URL;
}

export function emailSignatureLines(profile: EmailSignatureProfile): string[] {
  const name = profile.name?.trim();
  const role = profile.role?.trim();
  const company = profile.company?.trim().replace(/[\[\]]/g, "");
  const website = safeHttpUrl(profile.website);
  const companyLink = website
    ? `[${company || websiteLabel(website)}](${website})`
    : company;
  const roleCompany = [role, companyLink].filter(Boolean).join(" | ");

  return [
    "Best Regards,",
    name,
    `WhatsApp: [Start chatting](${whatsappStartUrl()})`,
    roleCompany,
  ].filter((line): line is string => Boolean(line?.trim()));
}

function safeHttpUrl(value?: string | null): string {
  if (!value?.trim()) return "";
  const input = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString().replace(/\/$/, "").replace(/\)/g, "%29")
      : "";
  } catch {
    return "";
  }
}

function websiteLabel(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return value;
  }
}
