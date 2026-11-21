import { createClient } from "./gen/client/client.gen.js";
import type { Config } from "./gen/client/types.gen.js";
import { DenClient } from "./gen/sdk.gen.js";

export * from "./gen/types.gen.js";
export { DenClient };

export type DenClientConfig = Config & {
  token?: string;
  apiKey?: string;
  orgId?: string;
  auditContext?: Readonly<{ correlationId: string }>;
};

export function createDenClient(config: DenClientConfig = {}) {
  const { token, apiKey, orgId, auditContext, ...options } = config;
  const auditCorrelationId = auditContext?.correlationId;
  const client = createClient({ baseUrl: "https://api.openworklabs.com", ...options });
  client.interceptors.request.use((request) => {
    if (token && !request.headers.has("authorization")) request.headers.set("authorization", `Bearer ${token}`);
    if (apiKey && !request.headers.has("x-api-key")) request.headers.set("x-api-key", apiKey);
    if (orgId && !request.headers.has("x-openwork-org-id")) request.headers.set("x-openwork-org-id", orgId);
    if (auditCorrelationId && !request.headers.has("X-OpenWork-Audit-Correlation")) request.headers.set("X-OpenWork-Audit-Correlation", auditCorrelationId);
    return request;
  });
  return new DenClient({ client });
}
