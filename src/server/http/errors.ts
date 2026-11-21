import { ZodError, type z } from "zod";

export type ErrorCode =
  | "bad_request"
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "upstream_error"
  | "internal_error";

/** Thrown by services/repositories, translated by `withApi`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message = "Bad request", details?: unknown) {
    return new ApiError(400, "bad_request", message, details);
  }
  static unauthorized(message = "Missing or invalid credentials") {
    return new ApiError(401, "unauthorized", message);
  }
  static forbidden(message = "Not allowed") {
    return new ApiError(403, "forbidden", message);
  }
  static notFound(message = "Resource not found") {
    return new ApiError(404, "not_found", message);
  }
  static conflict(message = "Already exists") {
    return new ApiError(409, "conflict", message);
  }
  static rateLimited(retryAfterSeconds: number) {
    return new ApiError(
      429,
      "rate_limited",
      `Too many requests. Retry in ${retryAfterSeconds}s.`,
      { retryAfterSeconds },
    );
  }
  static upstream(message: string, details?: unknown) {
    return new ApiError(502, "upstream_error", message, details);
  }
  static internal(message = "Unexpected server error") {
    return new ApiError(500, "internal_error", message);
  }
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_error: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  upstream_error: 502,
  internal_error: 500,
};

export function statusForCode(code: ErrorCode) {
  return STATUS_BY_CODE[code] ?? 500;
}

/** Flatten a ZodError into `{ path: message }` without relying on `.flatten()`. */
export function zodDetails(error: ZodError) {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_";
    if (!out[path]) out[path] = issue.message;
  }
  return out;
}

export function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "validation_error",
      "Request payload failed validation",
      zodDetails(parsed.error),
    );
  }
  return parsed.data as z.infer<T>;
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
