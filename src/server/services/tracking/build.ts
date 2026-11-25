import { clickUrl, pixelUrl } from "@/server/services/tracking/token";
import { escapeHtml } from "@/server/services/templates";

/**
 * Turns a stored body into the HTML that actually leaves the building.
 *
 * Ported from BlueOak Track's `server/html.ts`, with one important difference:
 * Upwork drafts are written as plain text (ChatGPT output, escaped by
 * `textToHtml`), so there are no `{{link:Label}}` placeholders to expand.
 * Instead the builder works on whatever it is given:
 *
 *   1. every `<a href>` whose destination is on the tracked list becomes `/c/<token>`
 *   2. if the body turned out to have no anchors at all, bare URLs in the *text
 *      nodes* are linkified — never inside a tag, so attributes and `<style>`
 *      blocks are left alone
 *   3. the 1×1 pixel is appended as the last element before `</body>`
 *
 * `preview: true` is what the dashboard renders: no pixel, and every tracked
 * destination points at a `#preview-<token>` fragment. Without that switch,
 * opening the draft panel would record an "open" for the recipient and a click
 * on our own hosting — which is exactly how tracking numbers become fiction.
 */

export interface TrackedLinkInput {
  token: string;
  label: string;
  destinationUrl: string;
}

export interface TrackedBody {
  html: string;
  /** The pixel address, returned so the send path can log it. */
  pixelSrc: string | null;
  /** Destinations that were rewritten to `/c/…` in this body. */
  rewritten: string[];
  /** Tracked links with no occurrence in the body (deliberately reported, never silent). */
  unused: string[];
}

const NON_TEXT_TAGS = /^(style|script|textarea|title)$/i;

export function buildTrackedHtml(options: {
  html: string;
  token: string;
  domain: string;
  links: TrackedLinkInput[];
  preview?: boolean;
}): TrackedBody {
  const { html, token, domain, preview = false } = options;
  const byDestination = new Map<string, TrackedLinkInput>(
    options.links.map((link) => [normalizeDestination(link.destinationUrl), link]),
  );

  const rewritten = new Set<string>();
  const withoutUnused = new Set(byDestination.keys());

  // 1. anchors
  let out = html.replace(
    /(href\s*=\s*)("\s*([^"]*?)\s*"|'\s*([^']*?)\s*')/gi,
    (match, prefix: string, _quoted: string, double?: string, single?: string) => {
      const raw = decodeEntities((double ?? single ?? "").trim());
      const key = normalizeDestination(raw);
      const link = byDestination.get(key);
      if (!link) return match;
      rewritten.add(link.destinationUrl);
      withoutUnused.delete(key);
      const href = clickUrl(domain, link.token, preview);
      return `${prefix}"${escapeHtml(href)}"`;
    },
  );

  // 2. bare URLs, only when the body had no tracked anchor at all
  if (rewritten.size === 0 && byDestination.size > 0) {
    out = mapTextNodes(out, (text) =>
      text.replace(/(https?:\/\/[^\s<>"']+)/g, (raw) => {
        const trailing = raw.match(/[.,;:!?)\]]+$/)?.[0] ?? "";
        const candidate = raw.slice(0, raw.length - trailing.length);
        const link = byDestination.get(normalizeDestination(candidate));
        if (!link) return raw;
        rewritten.add(link.destinationUrl);
        withoutUnused.delete(normalizeDestination(link.destinationUrl));
        const href = clickUrl(domain, link.token, preview);
        return `<a href="${escapeHtml(href)}">${escapeHtml(candidate)}</a>${trailing}`;
      }),
    );
  }

  // 3. the pixel
  const src = pixelUrl(domain, token, preview);
  const pixelSrc = preview ? null : src;
  if (pixelSrc) {
    out = insertPixel(
      out,
      `<img src="${escapeHtml(src)}" width="1" height="1" alt="" role="presentation" ` +
        `style="border:0;width:1px;height:1px;display:block;opacity:0" />`,
    );
  }

  return {
    html: out,
    pixelSrc,
    rewritten: [...rewritten],
    unused: [...withoutUnused].map((key) => byDestination.get(key)?.destinationUrl ?? key),
  };
}

/**
 * Remove every tracking pixel from a stored body.
 *
 * Used by the dashboard preview as a second belt over `preview: true`: a body
 * that was saved *after* being built for sending must never fire a real open
 * when someone on our side looks at it.
 */
export function stripTrackingPixels(html: string): string {
  return html.replace(
    /<img\b[^>]*\bsrc\s*=\s*(?:"[^"]*\/o\/[^"]*"|'[^']*\/o\/[^']*')[^>]*\/?>/gi,
    "",
  );
}

// ── internals ────────────────────────────────────────────────────────────

function insertPixel(html: string, tag: string): string {
  const body = /<\/body>/i;
  if (body.test(html)) return html.replace(body, `${tag}</body>`);
  const htmlEnd = /<\/html>/i;
  if (htmlEnd.test(html)) return html.replace(htmlEnd, `${tag}</html>`);
  return `${html}${tag}`;
}

/** Rewrite only what a browser would treat as text, never markup. */
function mapTextNodes(html: string, fn: (text: string) => string): string {
  let out = "";
  let cursor = 0;

  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open === -1) {
      out += fn(html.slice(cursor));
      break;
    }
    out += fn(html.slice(cursor, open));

    const close = html.indexOf(">", open);
    if (close === -1) {
      out += html.slice(open);
      break;
    }
    const tag = html.slice(open, close + 1);
    out += tag;
    cursor = close + 1;

    // Skip the whole element body for tags whose content is not text.
    const name = /^<\s*([a-z0-9]+)/i.exec(tag)?.[1];
    if (name && NON_TEXT_TAGS.test(name) && !tag.endsWith("/>")) {
      const end = findClosingTag(html, name, cursor);
      if (end === -1) {
        out += html.slice(cursor);
        cursor = html.length;
        break;
      }
      out += html.slice(cursor, end);
      cursor = end;
    }
  }

  return out;
}

function findClosingTag(html: string, name: string, from: number): number {
  const closing = new RegExp(`</\\s*${name}\\s*>`, "i");
  const rest = html.slice(from);
  const match = closing.exec(rest);
  return match ? from + match.index + match[0].length : -1;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'");
}

/**
 * `https://acme.com/` and `https://acme.com` are the same destination for
 * matching purposes. Invalid URLs are returned untouched so they simply never
 * match a tracked link.
 */
function normalizeDestination(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.hash = "";
    const normalized = url.toString();
    return normalized.replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/$/, "");
  }
}

export { normalizeDestination };
