import type { Contact } from "@/types/domain";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Very small line-break-preserving fallback for plain-text bodies. */
export function textToHtml(text: string) {
  return `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</div>`;
}

export function htmlToText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
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
