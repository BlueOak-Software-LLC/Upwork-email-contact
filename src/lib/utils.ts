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

export function formatRelative(input: string | Date | null | undefined) {
  if (!input) return "—";
  const d = typeof input === "string" ? new Date(input) : input;
  const diff = d.getTime() - Date.now();
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
    Math.round(diff / 86_400_000),
    "day",
  );
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
