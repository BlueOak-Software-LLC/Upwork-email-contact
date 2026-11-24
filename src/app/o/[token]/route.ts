import type { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { clientIp } from "@/server/http/auth";
import { rateLimit } from "@/server/http/rate-limit";
import { TRANSPARENT_GIF, isToken } from "@/server/services/tracking/token";
import { captureUserAgent } from "@/server/services/tracking/headers";
import { trackingRepo } from "@/server/db/tracking.repo";

export const dynamic = "force-dynamic";

/**
 * GET /o/<token>.gif — the tracking pixel.
 *
 * The most defensive route in the app, because the caller is a mail client and
 * a mail client shows a broken-image icon instead of an error page:
 *
 *  - **always** answers 200 with the GIF, including on a bad token, a rate
 *    limit, a database outage or an internal exception. A 500 here would teach
 *    the recipient's client that this sender's images fail.
 *  - **never** records for a token we do not recognise or one that is malformed
 *    — an empty pixel is the correct answer to a probe.
 *  - `no-store` on every response, so a proxy that caches the image is also
 *    caching the "open", and the second reader is invisible.
 *  - HEAD is identical minus the body: prefetchers and uptime probes use it.
 *
 * The middleware matcher already ignores `*.gif`, so this route is reachable
 * without a session by design; the token is the only credential.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const token = readToken((await context.params).token);
  if (token) await record(request, token);
  return gifResponse();
}

/**
 * Same headers, no body — a prefetch must not look like an open.
 *
 * Mail clients, link prefetchers and uptime probes send HEAD, and returning the
 * GET headers verbatim is what lets them check the route without counting.
 */
export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  void request;
  void context;
  return new Response(null, { status: 200, headers: gifHeaders() });
}

function readToken(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const withoutExtension = value.replace(/\.gif$/i, "");
  return isToken(withoutExtension) ? withoutExtension : null;
}

async function record(request: NextRequest, token: string): Promise<void> {
  try {
    // Per-IP ceiling only: the per-day cap lives in the RPC and is per message.
    rateLimit(`tracking:open:${clientIp(request)}`, 240, 60_000);
  } catch {
    // Over the limit — serve the image, record nothing.
    return;
  }

  try {
    const result = await trackingRepo.record("open", token, captureUserAgent(request.headers));
    if (result.recorded) {
      logger.info("tracking_open", { logId: result.logId, token: token.slice(0, 8) });
    } else if (result.found && !result.duplicate && !result.capped) {
      logger.warn("tracking_open_not_recorded", { token: token.slice(0, 8) });
    }
  } catch (error) {
    logger.error("tracking_open_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function gifResponse(): Response {
  return new Response(new Uint8Array(TRANSPARENT_GIF), { status: 200, headers: gifHeaders() });
}

function gifHeaders(): HeadersInit {
  return {
    "Content-Type": "image/gif",
    "Content-Length": String(TRANSPARENT_GIF.byteLength),
    // A cached pixel is an uncounted reader, so nothing here may be stored.
    "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "X-Content-Type-Options": "nosniff",
  };
}
