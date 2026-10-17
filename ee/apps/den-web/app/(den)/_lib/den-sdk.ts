import { createDenClient } from "@openwork/sdk/browser";
import { getRequestError, requestDenResponse } from "./den-flow";

/** Generated routes over the dashboard's existing auth, organization and deadline transport. */
export function createDenBrowserClient({ timeoutMs = 30_000 }: { timeoutMs?: number } = {}) {
  return createDenClient({
    baseUrl: window.location.origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      return requestDenResponse(`${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.blob(),
        signal: request.signal,
      }, timeoutMs);
    },
  });
}

export async function denBrowserData<T>(pending: Promise<{ data?: T; error?: unknown; response?: Response }>): Promise<T> {
  const { data, error, response } = await pending;
  if (!response) throw error ?? new Error("Den request failed.");
  if (!response.ok) throw getRequestError(error, response, `Automation request failed (${response.status}).`);
  if (data === undefined) throw new Error("Automation response was empty.");
  return data;
}
