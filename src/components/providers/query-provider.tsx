"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

export function QueryProvider({ children }: { children: ReactNode }) {
  // Created inside the provider's own state so each browser tab gets one cache.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (count, error) => {
              const status = (error as { status?: number })?.status;
              if (status && status < 500) return false;
              return count < 2;
            },
            refetchOnWindowFocus: false,
            staleTime: 15_000,
          },
          mutations: { retry: 0 },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
