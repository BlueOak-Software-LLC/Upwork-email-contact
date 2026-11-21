import { NextResponse } from "next/server";
import type { Paged } from "@/types/domain";

/** Uniform success envelope: `{ data, meta? }`. */
export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ data }, { status: 200, ...init });
}

export function created(data: unknown) {
  return NextResponse.json({ data }, { status: 201 });
}

export function paged<T>({
  items,
  page,
  pageSize,
  total,
  totalPages,
}: Paged<T>,
init?: ResponseInit) {
  return NextResponse.json(
    { data: items, meta: { page, pageSize, total, totalPages } },
    { status: 200, ...init },
  );
}

export function noContent() {
  return new NextResponse(null, { status: 204 });
}

export function fail(
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    },
    { status },
  );
}

/** Short-lived JSON so the dashboard can cache lists without a CDN layer. */
export function withRevalidation(seconds: number) {
  return { headers: { "Cache-Control": `private, max-age=${seconds}` } };
}
