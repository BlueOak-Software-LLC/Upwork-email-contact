import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { logger } from "@/lib/logger";
import { isApiError, statusForCode, zodDetails } from "@/server/http/errors";
import { fail } from "@/server/http/responses";

type RouteContext<P> = { params: Promise<P> };
type Handler<P> = (
  request: NextRequest,
  context: RouteContext<P>,
) => Promise<NextResponse | Response>;

/**
 * Wrap every route handler: request id, structured logging, and a single
 * error → JSON translation so handlers can just `throw ApiError.*`.
 */
export function withApi<P = Record<string, never>>(handler: Handler<P>): Handler<P> {
  return async (request, context) => {
    const requestId =
      request.headers.get("x-request-id") ?? randomUUID().slice(0, 8);
    const startedAt = performance.now();
    const base = {
      requestId,
      method: request.method,
      path: new URL(request.url).pathname,
    };

    try {
      const response = await handler(request, context);
      response.headers.set("x-request-id", requestId);
      logger.info("api_request", {
        ...base,
        status: response.status,
        ms: Math.round(performance.now() - startedAt),
      });
      return response;
    } catch (error) {
      const translated = toResponse(error, requestId);
      translated.headers.set("x-request-id", requestId);
      logger.error("api_error", {
        ...base,
        status: translated.status,
        ms: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
      return translated;
    }
  };
}

function toResponse(error: unknown, requestId: string) {
  if (isApiError(error)) {
    const response = fail(error.status, error.code, error.message, error.details);
    if (error.code === "rate_limited") {
      const retry = (error.details as { retryAfterSeconds?: number })?.retryAfterSeconds;
      if (retry) response.headers.set("Retry-After", String(retry));
    }
    return response;
  }

  if (error instanceof ZodError) {
    return fail(422, "validation_error", "Request payload failed validation", zodDetails(error));
  }

  if (error instanceof SyntaxError) {
    return fail(400, "bad_request", "Body is not valid JSON");
  }

  logger.error("api_unhandled_error", {
    requestId,
    error: error instanceof Error ? error.message : String(error),
  });
  // In development, surface the real failure instead of an opaque 500 —
  // production keeps the message generic.
  const debug =
    process.env.NODE_ENV !== "production" && error instanceof Error
      ? { type: error.name, message: error.message, stack: error.stack?.split("\n").slice(0, 6).join("\n") }
      : undefined;
  return fail(
    statusForCode("internal_error"),
    "internal_error",
    process.env.NODE_ENV !== "production" && error instanceof Error
      ? error.message
      : "Unexpected server error",
    debug,
  );
}
