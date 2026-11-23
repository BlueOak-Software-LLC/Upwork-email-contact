import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(input: string | Date | null | undefined) {
  if (!input) return "—";
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

/** Full wall-clock string with seconds — used as the title behind <TimeAgo>. */
export function formatAbsolute(input: string | Date) {
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(d);
}

export function formatRelative(input: string | Date | null | undefined) {
  if (!input) return "—";
  const d = typeof input === "string" ? new Date(input) : input;
  const diff = d.getTime() - Date.now();
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
    Math.round(diff / 86_400_000),
    "day",
  );
}

/**
 * Compact relative time for dense lists: "just now", "12 min ago", "3 h ago".
 * Pure and server-safe, so the overview can use it too; <TimeAgo> wraps it and
 * keeps itself current on a minute tick.
 */
export function relative(input: string | Date, withSuffix = true): string {
  const then = new Date(input).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.round((Date.now() - then) / 1000);
  const suffix = withSuffix ? " ago" : "";
  if (seconds < 0) return `in ${Math.abs(seconds)} s`;
  if (seconds < 45) return "just now";
  if (seconds < 90) return `1 min${suffix}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min${suffix}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h${suffix}`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} d${suffix}`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo${suffix}`;
  return `${Math.round(months / 12)} y${suffix}`;
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function truncate(value: string, max = 60) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Build a URL for our own API routes from typed-ish params. */
export function apiUrl(path: string, params?: Record<string, string | number | undefined>) {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, "http://placeholder");
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== "" && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}
