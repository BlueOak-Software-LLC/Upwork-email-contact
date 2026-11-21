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
