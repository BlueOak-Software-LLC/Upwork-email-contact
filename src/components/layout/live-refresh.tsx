"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * Keeps server-rendered screens (Overview, Email log) honest without a manual
 * refresh: re-runs the server components when the tab regains focus, when the
 * browser comes back online, and on a slow interval.
 *
 * Lead pages are excluded — they are driven by TanStack Query, which refetches
 * on focus and is updated directly by every mutation, so refreshing the shell
 * underneath would only throw work away.
 */
export function LiveRefresh({
  intervalMs = 30_000,
  throttleMs = 12_000,
}: {
  intervalMs?: number;
  throttleMs?: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const last = useRef(0);

  useEffect(() => {
    if (pathname.startsWith("/leads/")) return;

    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last.current < throttleMs) return;
      last.current = now;
      router.refresh();
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };

    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(refresh, intervalMs);

    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [router, pathname, intervalMs, throttleMs]);

  return null;
}
