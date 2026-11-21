import { getServerEnv } from "@/lib/env";

type Level = "debug" | "info" | "warn" | "error";
const order: Level[] = ["debug", "info", "warn", "error", "silent"];

/** Minimal structured logger — swap for pino/otel without touching callers. */
export const logger = {
  debug: (msg: string, meta?: LogMeta) => write("debug", msg, meta),
  info: (msg: string, meta?: LogMeta) => write("info", msg, meta),
  warn: (msg: string, meta?: LogMeta) => write("warn", msg, meta),
  error: (msg: string, meta?: LogMeta) => write("error", msg, meta),
};

export type LogMeta = Record<string, unknown> | undefined;

function write(level: Level, message: string, meta: LogMeta) {
  let threshold: Level = "info";
  try {
    threshold = getServerEnv().LOG_LEVEL;
  } catch {
    // env not ready yet (build / edge) — use default
  }
  if (order.indexOf(level) < order.indexOf(threshold)) return;

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
