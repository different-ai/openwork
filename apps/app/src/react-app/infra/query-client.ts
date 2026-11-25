import { QueryClient } from "@tanstack/react-query";

type QueryClientGlobal = typeof globalThis & {
  __owReactQueryClient?: QueryClient;
};

export function getReactQueryClient(): QueryClient {
  const target = globalThis as QueryClientGlobal;
  if (target.__owReactQueryClient) return target.__owReactQueryClient;
  const queryClient = new QueryClient();

  for (const queryKey of [
    ["react-session-transcript"],
    ["react-session-status"],
    ["react-session-permissions"],
    ["react-session-questions"],
    ["react-session-todos"],
  ] as const) {
    queryClient.setQueryDefaults(queryKey, { gcTime: Infinity });
  }

  target.__owReactQueryClient = queryClient;
  return target.__owReactQueryClient;
}
