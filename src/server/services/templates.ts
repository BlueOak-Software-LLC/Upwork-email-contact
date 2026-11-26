import type { Contact } from "@/types/domain";

/** Readable link text for a URL: host and path, without scheme, "www." or trailing slash. */
export function readableLinkLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const label = `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`;
    return label.length <= 60 ? label : `${label.slice(0, 57)}...`;
  } catch {
    return url;
  }
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Escape and render the email body's intentionally small Markdown subset. */
export function textToHtml(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const rendered: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) rendered.push("</ul>");
    inList = false;
  };

  for (const line of lines) {
    const item = line.match(/^\s*[•*-]\s+(.+)$/);
    if (item) {
      if (!inList) {
        rendered.push('<ul style="margin:0 0 12px 22px;padding:0">');
        inList = true;
      }
      rendered.push(`<li style="margin:0 0 5px">${formatEmailInline(item[1] ?? "")}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    const indent = line.match(/^\s+/)?.[0].length ?? 0;
    rendered.push(
      `<p style="margin:0 0 12px${indent ? ` ${Math.min(indent * 4, 40)}px` : ""}">${formatEmailInline(line.trim())}</p>`,
    );
  }
  closeList();
  return `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif">${rendered.join("")}</div>`;
}

function formatEmailInline(value: string): string {
  const tokens: string[] = [];
  const withLinks = value.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)/g,
    (match, label?: string, markdownUrl?: string, rawUrl?: string) => {
      const rawDestination = markdownUrl ?? rawUrl ?? "";
      const url = rawDestination.replace(/[.,;:!?]+$/, "");
      const suffix = label && markdownUrl ? "" : rawDestination.slice(url.length);
      let safeUrl: URL | null = null;
      try {
        safeUrl = new URL(url);
      } catch {
        safeUrl = null;
      }
      if (!safeUrl || !["http:", "https:"].includes(safeUrl.protocol)) return match;
      const anchor = `<a href="${escapeHtml(url)}" style="color:#1769aa;text-decoration:underline">${escapeHtml(label?.trim() && !/^https?:\/\//i.test(label.trim()) ? label : readableLinkLabel(url))}</a>${escapeHtml(suffix)}`;
      const token = `\u0000${tokens.length}\u0000`;
      tokens.push(anchor);
      return token;
    },
  );
  let escaped = escapeHtml(withLinks).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  tokens.forEach((anchor, index) => {
    escaped = escaped.replace(`\u0000${index}\u0000`, anchor);
  });
  return escaped;
}

export function htmlToText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/ul>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    // A labelled link keeps its destination in the plain-text part: "Label (URL)".
    .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      if (!text || text === href) return href;
      return `${text} (${href})`;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function wrapEmailTemplate(body: string, opts?: { preheader?: string }) {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f6f8">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0"
                 style="max-width:600px;background:#fff;border-radius:12px;padding:28px;font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#16181d">
            ${opts?.preheader ? `<div style="color:#6b7280;font-size:13px;margin-bottom:16px">${escapeHtml(opts.preheader)}</div>` : ""}
            ${body}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Default first-touch message used by the dashboard's "Send email" composer. */
export function outreachText(contact: Contact, senderName = "the team") {
  return [
    `Hi ${contact.name.split(" ")[0] || contact.name},`,
    "",
    `I came across ${contact.company ? `${contact.company} ` : ""}and thought one of our current projects could be a fit.`,
    "Are you open to a quick 15-minute call this week?",
    "",
    `Best,`,
    senderName,
  ].join("\n");
}

export function outreachHtml(contact: Contact, text: string) {
  return wrapEmailTemplate(
    `<p>Hi ${escapeHtml(contact.name.split(" ")[0] || contact.name)},</p>
     <div style="white-space:pre-wrap">${escapeHtml(text)}</div>`,
    { preheader: contact.company ? `Re: ${contact.company}` : undefined },
  );
}

export { escapeHtml };
