"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * DashboardQueryClientProvider
 *
 * Scopes a single QueryClient instance to the org dashboard subtree.
 * Keeps den-web's React Query surface narrow — any new dashboard feature
 * (plugins, etc.) can use useQuery/useMutation without leaking client state
 * across other top-level routes.
 */
export function DashboardQueryClientProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
