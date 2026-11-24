import { randomBytes } from "node:crypto";

/**
 * Tracking secrets.
 *
 * A token is the only thing standing between an anonymous GET and "who opened
 * what", so it is 24 random bytes (188 bits) rendered base64url. Never
 * sequential, never derived from a row id: a guessable token would let anyone
 * walk the delivery log from the outside.
 *
 * The shape is enforced a second time inside `record_tracking_event` (`!~
 * '^[A-Za-z0-9_-]{16,128}$'`), so a malformed path never reaches a query.
 */

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** 32 characters of base64url — no padding, so it is safe in a URL and in `srcset`. */
export function mintToken(): string {
  return randomBytes(24).toString("base64url");
}

export function isToken(value: string | undefined | null): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/**
 * `/o/<token>.gif` and `/c/<token>`.
 *
 * `preview: true` produces the inert form used by every in-app preview: the
 * pixel has no host to call and links land on a fragment, so reviewing a draft
 * can never be mistaken for a client reading it.
 */
export function pixelUrl(domain: string, token: string, preview = false): string {
  if (preview) return `#preview-${token}`;
  return `${trimSlash(domain)}/o/${encodeURIComponent(token)}.gif`;
}

export function clickUrl(domain: string, token: string, preview = false): string {
  if (preview) return `#preview-${token}`;
  return `${trimSlash(domain)}/c/${encodeURIComponent(token)}`;
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

/**
 * The 1×1 transparent GIF89a.
 *
 * Handled as a constant rather than a file read: this is returned on the hot
 * path of every mail client that loads an image, including the ones that
 * request a pixel for a token we do not recognise.
 */
export const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
