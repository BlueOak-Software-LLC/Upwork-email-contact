import { getServerEnv } from "@/lib/env";

type Level = "debug" | "info" | "warn" | "error" | "silent";
const order: Level[] = ["debug", "info", "warn", "error", "silent"];

/** Minimal structured logger — swap for pino/otel without touching callers. */
export const logger = {
  debug: (msg: string, meta?: LogMeta) => write("debug", msg, meta),
  info: (msg: string, meta?: LogMeta) => write("info", msg, meta),
  warn: (msg: string, meta?: LogMeta) => write("warn", msg, meta),
  error: (msg: string, meta?: LogMeta) => write("error", msg, meta),
};

export type LogMeta = Record<string, unknown> | undefined;

/**
 * The daily console keeps two signals only: a lead arrived and a ChatGPT
 * answer came back. Everything else (per-request API lines, prompt prep,
 * tracking, status touches) is intentionally quiet. Set `LOG_LEVEL=debug` when
 * you need the full trail while debugging.
 */
const ALWAYS_LOGGED = new Set(["leads_received", "chatgpt_response_received"]);

export function isQuietLog(message: string): boolean {
  return !ALWAYS_LOGGED.has(message);
}

function write(level: Level, message: string, meta: LogMeta) {
  let threshold: Level = "info";
  let verbose = false;
  try {
    threshold = getServerEnv().LOG_LEVEL;
    verbose = threshold === "debug";
  } catch {
    // env not ready yet (build / edge) — use default
  }
  // The allow-list is absolute: the two receive lines are written even when
  // LOG_LEVEL is "error". Every other line is dropped unless debugging, and
  // then still respects the configured threshold.
  const required = !isQuietLog(message);
  if (!required && !verbose) return;
  if (!required && order.indexOf(level) < order.indexOf(threshold)) return;

  const line = {
    level,
    message,
    at: new Date().toISOString(),
    ...(meta ?? {}),
  };
  const out = JSON.stringify(line, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  if (level === "error") console.error(out);
  else console.log(out);
}

/** Never log secrets or PII beyond what we explicitly keep. */
export function redact(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const sensitive = /^(.*key|.*token|.*password|.*secret|authorization|cookie)$/i;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, sensitive.test(k) ? "[redacted]" : v]),
  );
}
