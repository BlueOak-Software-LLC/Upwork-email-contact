/**
 * RFC 5322 Message-ID headers for follow-up threading.
 *
 * The provider id is stored in `email_logs.provider_message_id`. SMTP returns
 * the real Message-ID (`<...@domain>`); some APIs return an opaque id that is
 * not a header value, so it is ignored rather than producing a malformed
 * message. The subject still starts with `Re:` either way; this just lets
 * clients group the messages into one conversation.
 */
const MESSAGE_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;

export function normalizeMessageId(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  return candidate && MESSAGE_ID.test(candidate) ? candidate : null;
}

/**
 * `parentIds` is nearest-first: [parent, grandparent, ...]. `References` must
 * be oldest-first and end with the immediate parent; `In-Reply-To` is that
 * immediate parent alone.
 */
export function buildThreadHeaders(
  parentIds: string[],
  messageIds: Map<string, string | null | undefined>,
): Record<string, string> {
  const immediate = normalizeMessageId(messageIds.get(parentIds[0] ?? ""));
  if (!immediate) return {};
  const references = [...parentIds]
    .reverse()
    .map((id) => normalizeMessageId(messageIds.get(id)))
    .filter((id): id is string => Boolean(id));
  return {
    "In-Reply-To": immediate,
    ...(references.length ? { References: references.join(" ") } : {}),
  };
}
