import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center p-8 text-center">
      <div>
        <p className="text-6xl font-semibold tracking-tight text-muted">404</p>
        <h1 className="mt-3 text-lg font-medium">Page not found</h1>
        <p className="mt-1 text-sm text-muted">
          That route does not exist in this dashboard.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink focus-ring"
        >
          Back to overview
        </Link>
      </div>
    </main>
  );
}
