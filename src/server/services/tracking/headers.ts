/**
 * What we keep about the client that fetched a pixel or clicked a link.
 *
 * Truncation is deliberate and happens in three places on purpose: here, so an
 * arbitrarily long `User-Agent` never leaves the function; in the SQL guard, so
 * a direct RPC call cannot smuggle more; and the fact that no IP address is
 * stored at all. The user agent is the only hint of a device class available,
 * and it is the string that makes the 60-second dedupe window per client rather
 * than per message.
 */
export const USER_AGENT_LIMIT = 300;

export function captureUserAgent(headers: Headers): string {
  return (headers.get("user-agent") ?? "").slice(0, USER_AGENT_LIMIT);
}
