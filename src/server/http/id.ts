import { ApiError } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Route params arrive as strings we then hand to PostgREST, and Postgres answers
 * a malformed uuid with `invalid input syntax for type uuid` — which surfaced as
 * a 502 upstream error for what is really a bad request (an 8-character id pasted
 * from a log line, a truncated URL, a crawler guessing).
 *
 * Validate at the edge instead: same message, 400, no database round-trip.
 */
export function requireUuid(value: string, label = "id"): string {
  if (!UUID.test(value)) {
    throw ApiError.badRequest(`${label} must be a UUID (got "${value.slice(0, 40)}")`, {
      [label]: "expected 36-character uuid, e.g. 6b3f1a44-9c0d-4e3a-9b1c-2f5d8a7e1b30",
    });
  }
  return value;
}

/** Same guard for the many `:id` routes, after `await params`. */
export function requireParamId(raw: string | string[] | undefined, label = "id"): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw ApiError.badRequest(`${label} is required`);
  return requireUuid(value, label);
}
