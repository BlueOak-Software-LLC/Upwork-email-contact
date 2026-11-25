import { validateDestination } from "@/server/services/tracking/urls";

/**
 * Which URLs in a message become tracked links.
 *
 * BlueOak Track has an authoring UI where a human names each link; Upwork
 * drafts are written as plain text and reviewed as text, so the
 * destinations are discovered instead: every `http(s)` URL that appears in the
 * body, bare or inside an `href`.
 *
 * Anything that fails `validateDestination` is dropped here rather than
 * redirected later, so a scrape of a post containing `http://169.254.169.254/`
 * never becomes a clickable link in an email that claims to be from us.
 *
 * The reviewed PPD's own `references` are deliberately **not** turned into
 * tracked links: the proposal travels as an attached PDF, and a `/c/<token>`
 * rewrite cannot live inside a document the reviewer approved and the compiler
 * typeset. Minting rows for them would create redirects nobody can click and
 * click counts that always read zero.
 */
export interface LinkCandidate {
  destinationUrl: string;
  label: string;
}

/** A URL in running text: stops at whitespace, quotes, angle brackets and markup. */
const BARE_URL = /https?:\/\/[^\s<>"')\]]+/g;

/** Trailing punctuation is sentence punctuation, not part of the link. */
const TRAILING = /[.,;:!?)\]]+$/;

export function discoverLinks(input: {
  text?: string | null;
  html?: string | null;
  /** Cap so a pathological body cannot mint thousands of link rows per send. */
  max?: number;
}): LinkCandidate[] {
  const max = input.max ?? 12;
  const found: LinkCandidate[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const checked = validateDestination(stripTrailing(raw));
    if (!checked.ok) return;
    const key = checked.url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ destinationUrl: checked.url, label: labelFor(checked.url) });
  };

  if (input.text) {
    for (const match of input.text.matchAll(BARE_URL)) push(match[0]);
  }
  if (input.html) {
    for (const match of input.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
      // Entities inside an attribute are encoding, not part of the URL.
      push(decodeEntities(match[1] ?? ""));
    }
    for (const match of input.html.matchAll(BARE_URL)) push(match[0]);
  }

  return found.slice(0, max);
}

/** `data.acme.com/pricing` — a label that says what the link is, not "click here". */
export function labelFor(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean)[0];
    return path ? `${host}/${path}` : host;
  } catch {
    return url.slice(0, 60);
  }
}

/**
 * Entities inside an attribute value are part of the encoding, not the URL.
 * `&amp;` in an `href` means `&`, and a tracked link never needs the reverse.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'");
}

function stripTrailing(value: string): string {
  return value.replace(TRAILING, "");
}
