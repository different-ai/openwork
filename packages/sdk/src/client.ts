import { createClient } from "./gen/client/client.gen.js";
import type { Config } from "./gen/client/types.gen.js";
import { DenClient } from "./gen/sdk.gen.js";

export * from "./gen/types.gen.js";
export { DenClient };

export type DenClientConfig = Config & {
  /** Den user session token. Session-only operations require this credential. */
  token?: string;
  /** Organization API key, sent verbatim in x-api-key. */
  apiKey?: string;
  /** Organization context for organization-scoped operations. */
  orgId?: string;
};

export function createDenClient(config: DenClientConfig = {}) {
  const { token, apiKey, orgId, ...options } = config;
  const client = createClient({ baseUrl: "https://api.openworklabs.com", ...options });
  // Interceptors preserve all supported header forms and per-request overrides.
  client.interceptors.request.use((request) => {
    if (token && !request.headers.has("authorization")) request.headers.set("authorization", `Bearer ${token}`);
    if (apiKey && !request.headers.has("x-api-key")) request.headers.set("x-api-key", apiKey);
    if (orgId && !request.headers.has("x-openwork-org-id")) request.headers.set("x-openwork-org-id", orgId);
    return request;
  });
  return new DenClient({ client });
}
