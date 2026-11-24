import type { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { clientIp } from "@/server/http/auth";
import { rateLimit } from "@/server/http/rate-limit";
import { isToken } from "@/server/services/tracking/token";
import { captureUserAgent } from "@/server/services/tracking/headers";
import { validateDestination } from "@/server/services/tracking/urls";
import { trackingRepo } from "@/server/db/tracking.repo";

export const dynamic = "force-dynamic";

/**
 * GET /c/<token> — tracked link redirect.
 *
 * Order matters, and each step exists for a reason:
 *
 *  1. look the token up; an unknown token is a 404, never a redirect to
 *     something we did not choose.
 *  2. re-validate the destination **now**. The check at send time only proves
 *     what we wrote; this is what stops `/c/` from becoming an open redirect or
 *     an SSRF probe if a row was edited afterwards (`http://169.254.169.254/`
 *     is a real value that can arrive inside a scraped Upwork post).
 *  3. HEAD requests redirect without recording — a link scanner is not a click.
 *  4. record the click, then redirect regardless of the outcome. A capped or
 *     failed event must never cost the recipient their destination: the click
 *     is the useful part, the number is the by-product.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const token = readToken((await context.params).token);
  if (!token) return plainResponse(404, "Not found");

  return handle(request, token, /* record */ true);
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const token = readToken((await context.params).token);
  if (!token) return plainResponse(404, "Not found");
  return handle(request, token, /* record */ false);
}

async function handle(
  request: NextRequest,
  token: string,
  record: boolean,
): Promise<Response> {
  let destination: string | null = null;

  try {
    const link = await trackingRepo.linkByToken(token);
    if (!link) return plainResponse(404, "Not found");

    const checked = validateDestination(link.destination_url);
    if (!checked.ok) {
      logger.warn("tracking_link_destination_rejected", {
        linkId: link.id,
        reason: checked.error,
      });
      return plainResponse(400, "This link is no longer valid.");
    }
    destination = checked.url;

    if (!record) return redirectResponse(destination);

    try {
      rateLimit(`tracking:click:${clientIp(request)}`, 240, 60_000);
    } catch {
      return redirectResponse(destination);
    }

    const result = await trackingRepo.record("click", token, captureUserAgent(request.headers));
    if (result.recorded) {
      logger.info("tracking_click", {
        logId: result.logId,
        linkId: link.id,
        destination: hostOf(destination),
      });
    }
    return redirectResponse(destination);
  } catch (error) {
    logger.error("tracking_click_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    // We know where they were going: send them there rather than fail a reader.
    return destination
      ? redirectResponse(destination)
      : plainResponse(404, "Not found");
  }
}

function readToken(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  return isToken(value) ? value : null;
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
      // The destination should not learn the recipient's address from the referer.
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function plainResponse(status: number, message: string): Response {
  return new Response(status === 404 ? "Not found" : message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}
