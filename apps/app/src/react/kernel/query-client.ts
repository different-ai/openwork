import { QueryClient } from "@tanstack/react-query";

let client: QueryClient | null = null;

export function getReactQueryClient() {
  if (client) return client;
  client = new QueryClient();
  return client;
}
