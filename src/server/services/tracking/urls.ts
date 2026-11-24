/**
 * Destination guard for tracked links — ported from BlueOak Track's
 * `server/urls.ts`.
 *
 * Two reasons this exists here rather than being a nice-to-have:
 *
 * 1. Link text and URLs in this app come from a scraped Upwork post and from
 *    model output. A destination is therefore untrusted input, and `/c/<token>`
 *    is an open redirect with a server-side fetch attached unless it is checked.
 * 2. The check runs again **at click time**, not only at send time, so a row
 *    edited directly in Postgres cannot turn the redirect into an SSRF probe of
 *    the metadata endpoint or the private network.
 */

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"]);

export type DestinationResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export function validateDestination(value: string): DestinationResult {
  const raw = value.trim();
  if (!raw || raw.length > 2000) return { ok: false, error: "Enter an HTTP or HTTPS destination URL." };
  if (/[\s<>]/.test(raw)) return { ok: false, error: "The destination URL contains unsupported characters." };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "Enter a valid HTTP or HTTPS URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only HTTP and HTTPS destinations are allowed." };
  }
  if (parsed.username || parsed.password) return { ok: false, error: "URLs with embedded credentials are not allowed." };

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, error: "That destination host is not allowed." };
  }
  if (isPrivateAddress(host)) return { ok: false, error: "Private and local destinations are not allowed." };

  return { ok: true, url: parsed.toString() };
}

function isPrivateAddress(host: string) {
  if (host === "::1" || host === "0.0.0.0" || host === "::") return true;
  if (isPrivateIpv6(host)) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return true;
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

/**
 * Covers ::1, unique-local, link-local, multicast, unspecified and the
 * IPv4-mapped forms (`::ffff:7f00:1`) that `URL` produces for 127.0.0.1.
 */
function isPrivateIpv6(host: string) {
  const bytes = expandIpv6(host.toLowerCase().replace(/^\[|\]$/g, ""));
  if (!bytes) return false;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hex === "00000000000000000000000000000000" || hex === "00000000000000000000000000000001") return true;
  if (/^f[cd]/.test(hex.slice(0, 2))) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(hex.slice(0, 4))) return true; // fe80::/10 link-local
  if (hex.slice(0, 2) === "ff") return true; // multicast
  if (hex.startsWith("00000000000000000000ffff")) return isPrivateAddress(bytes.slice(12).join("."));
  return false;
}

/** Full 16-byte expansion, including `::` shorthand; null when not IPv6. */
function expandIpv6(value: string): number[] | null {
  if (!value.includes(":")) return null;
  const address = value.split("%")[0] ?? value;
  const parts = address.split("::");
  if (parts.length > 2) return null;
  const groups = (text: string | undefined) =>
    !text || text === "" ? [] : text.split(":").map((group) => Number.parseInt(group, 16));
  const head = groups(parts[0]);
  const tail = groups(parts[1]);
  if ([...head, ...tail].some((group) => !Number.isFinite(group) || group < 0 || group > 0xffff)) return null;
  if (parts.length === 1) {
    if (head.length !== 8) return null;
    return head.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
  }
  if (head.length + tail.length > 7) return null;
  const fill = Array.from({ length: 8 - head.length - tail.length }, () => 0);
  return [...head, ...fill, ...tail].flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
}
