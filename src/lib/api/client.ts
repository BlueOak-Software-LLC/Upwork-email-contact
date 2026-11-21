"use client";

/**
 * Typed fetch wrapper for our own /api routes.
 * Understands the `{ data, meta }` / `{ error: { code, message, details } }` envelope.
 */
import { ApiClientError } from "./errors";

export interface Envelope<T> {
  data: T;
  meta?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

type FetchInit = Omit<RequestInit, "body"> & {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
};

export function buildUrl(path: string, query?: FetchInit["query"]) {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

export async function apiFetch<T, M = Envelope<T>["meta"]>(
  path: string,
  init: FetchInit = {},
): Promise<{ data: T; meta?: M }> {
  const { query, body, headers, ...rest } = init;

  const response = await fetch(buildUrl(path, query), {
    ...rest,
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  const payload = text ? safeJson(text) : null;

  if (!response.ok) {
    const err = (payload as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error;
    throw new ApiClientError(err?.message ?? `Request failed (${response.status})`, {
      status: response.status,
      code: err?.code ?? "http_error",
      details: err?.details,
    });
  }

  return payload as { data: T; meta?: M };
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: "bad_gateway", message: text.slice(0, 200) } };
  }
}
