import { allocateFreePorts } from "@openwork/cdp";
import { faultProxy, type Seed } from "@openwork/env";
import { gatewayUsageLimitPolicySchema } from "@openwork/types/den/gateway-usage-limits";
import { isRecord } from "./library.ts";

export function providerLimitScope(seed: Seed) { return limitScopeWorld(seed, false); }
export function providerLimitScopeDefault(seed: Seed) { return limitScopeWorld(seed, true); }

async function limitScopeWorld(seed: Seed, withDefault: boolean) {
  await using setup = new AsyncDisposableStack();
  const [api, webPort] = await allocateFreePorts(2);
  if (!api || !webPort) throw new Error("Missing isolated Den ports");
  const faults = setup.use(await faultProxy({ apiUrl: `http://127.0.0.1:${api}`, webUrl: `http://127.0.0.1:${webPort}` }));
  const den = setup.use(await seed.den({
    ports: { api, web: webPort }, webApiBase: faults.ref.apiUrl, trustedOrigins: [faults.ref.webUrl],
    env: { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:1", GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:1" },
    org: { name: "Provider limit recovery", admin: { name: "Limit owner" } },
  }));
  const created = await seed.api(den.admin, "/v1/inference-providers", {
    method: "POST", body: JSON.stringify({ name: "Saved model provider", providerId: "openai", modelIds: ["gpt-4o-mini"] }),
  });
  const provider = isRecord(created.body) && isRecord(created.body.inferenceProvider) ? created.body.inferenceProvider : null;
  if (!created.response.ok || typeof provider?.id !== "string") throw new Error(`Provider setup failed: ${created.response.status} ${created.text}`);
  async function createLimit(name: string, providerId: string | null) {
    const saved = await seed.api(den.admin, "/v1/gateway/usage-limit-policies", {
      method: "POST", body: JSON.stringify({ name, providerId, hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "month", costUsd: "20" }] }),
    });
    if (!saved.response.ok) throw new Error(`Limit setup failed: ${saved.response.status}`);
    // This route returns the policy at the root, not { policy }. Parse the shipping contract.
    const policy = gatewayUsageLimitPolicySchema.parse(saved.body);
    const assigned = await seed.api(den.admin, `/v1/gateway/usage-limit-policies/${policy.id}/assignments`, {
      method: "POST", body: JSON.stringify({ organization: true }),
    });
    if (!assigned.response.ok) throw new Error(`Limit assignment failed: ${assigned.response.status}`);
    return policy;
  }
  const policy = await createLimit("Saved provider limit", provider.id);
  const defaultPolicy = withDefault ? await createLimit("Default provider limit", null) : null;
  if (!withDefault) {
    await faults.faults.latency("/api/den/v1/inference-providers?scope=manageable", 4000, { times: 1 });
    await faults.faults.status("/api/den/v1/inference-providers?scope=manageable", 503, { times: 1, body: { error: "Fixture provider lookup unavailable" } });
  }
  const browser = await seed.web({ den, signedInAs: den.admin,
    startPath: withDefault ? "/dashboard/ai-gateway?tab=limits" : `/dashboard/ai-gateway/limits/${policy.id}`,
    headless: true, viewport: { width: 1440, height: 1200 } });
  const owned = setup.move();
  return { den, web: browser, providerId: provider.id, policyId: policy.id, defaultPolicyId: defaultPolicy?.id ?? null, faults, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}
