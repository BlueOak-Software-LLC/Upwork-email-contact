export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    message: string,
    options: { status: number; code: string; details?: unknown },
  ) {
    super(message);
    this.name = "ApiClientError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
  }

  /** `{ field: "message" }` when the API returned field-level validation errors. */
  get fieldErrors(): Record<string, string> {
    const details = this.details as Record<string, string> | undefined;
    if (!details || typeof details !== "object") return {};
    return Object.fromEntries(
      Object.entries(details).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;
  }
}

/**
 * One readable line out of anything a request can throw: our typed API error
 * (with its field messages appended), a network failure, or a raw string.
 * Use this in toasts so a 422 never shows as "Request failed".
 */
export function errorMessage(error: unknown): string | null {
  if (!error) return null;

  if (error instanceof ApiClientError) {
    const fields = Object.entries(error.fieldErrors).map(([key, message]) => `${key}: ${message}`);
    // Nested details (Zod issues) are an array of { path, message }.
    const nested = Array.isArray(error.details)
      ? (error.details as Array<{ message?: string; path?: unknown }>)
          .slice(0, 4)
          .map((issue) =>
            [Array.isArray(issue.path) ? issue.path.join(".") : null, issue.message]
              .filter(Boolean)
              .join(": "),
          )
      : [];
    return [error.message, ...fields.slice(0, 4), ...nested.filter(Boolean)]
      .filter(Boolean)
      .join(" · ");
  }

  if (error instanceof Error) {
    return error.message === "Failed to fetch"
      ? "The app could not reach the API — is the server running?"
      : error.message;
  }

  return typeof error === "string" ? error : null;
}
