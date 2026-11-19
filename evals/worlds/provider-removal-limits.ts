import { randomInt } from "node:crypto";
import { queryDenDatabase, type Seed } from "@openwork/env";
import { gatewayUsageLimitPolicySchema } from "@openwork/types/den/gateway-usage-limits";
import { isRecord } from "./library.ts";

/** A provider id of the right shape that no organization owns: the provider row of a limit orphaned before the fix. */
function removedProviderId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return `ipr_01${Array.from({ length: 24 }, () => alphabet[randomInt(alphabet.length)]).join("")}`;
}

/**
 * An Acme owner with two OpenRouter-style Gateway providers: the old one (bad key) carries the organization's
 * $4,000 monthly hard limit. A second limit points at a provider that was deleted before deletions asked what to
 * do with limits, the state some organizations are already in. Provider removal cleanup is generally available.
 */
export async function providerRemovalLimits(seed: Seed) {
  await using setup = new AsyncDisposableStack();
  const den = setup.use(await seed.den({
    web: true,
    env: { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:1", GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:1" },
    org: { name: "Acme", admin: { name: "Acme Owner" } },
  }));
  const databaseUrl = den.database?.url;
  if (!databaseUrl) throw new Error("The orphaned limit needs the isolated Den database");
  async function createProvider(name: string) {
    const created = await seed.api(den.admin, "/v1/inference-providers", {
      method: "POST", body: JSON.stringify({ name, providerId: "openai", modelIds: ["gpt-4o-mini"] }),
    });
    const provider = isRecord(created.body) && isRecord(created.body.inferenceProvider) ? created.body.inferenceProvider : null;
    if (!created.response.ok || typeof provider?.id !== "string") throw new Error(`Provider setup failed: ${created.response.status} ${created.text}`);
    return provider.id;
  }
  async function createLimit(name: string, providerId: string) {
    const saved = await seed.api(den.admin, "/v1/gateway/usage-limit-policies", {
      method: "POST", body: JSON.stringify({ name, providerId, hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "month", costUsd: "4000" }] }),
    });
    if (!saved.response.ok) throw new Error(`Limit setup failed: ${saved.response.status} ${saved.text}`);
    const policy = gatewayUsageLimitPolicySchema.parse(saved.body);
    const assigned = await seed.api(den.admin, `/v1/gateway/usage-limit-policies/${policy.id}/assignments`, {
      method: "POST", body: JSON.stringify({ organization: true }),
    });
    if (!assigned.response.ok) throw new Error(`Limit assignment failed: ${assigned.response.status}`);
    return policy.id;
  }
  const oldProviderId = await createProvider("Old OpenRouter key");
  const newProviderId = await createProvider("Acme OpenRouter");
  const policyId = await createLimit("Acme monthly cap", oldProviderId);
  // Arrange only: before this change a provider delete left its limits pointing at nothing.
  const orphanPolicyId = await createLimit("Research monthly cap", newProviderId);
  await queryDenDatabase(databaseUrl, "UPDATE gateway_usage_limit_policy SET inference_provider_id = ? WHERE id = ?", [removedProviderId(), orphanPolicyId]);
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway?tab=limits", headless: true, viewport: { width: 1440, height: 1200 } });
  const owned = setup.move();
  return {
    den, web, oldProviderId, newProviderId, policyId, orphanPolicyId,
    providerUrl: (id: string) => `${den.ref.webUrl}/dashboard/ai-gateway/providers/${encodeURIComponent(id)}`,
    limitsUrl: `${den.ref.webUrl}/dashboard/ai-gateway?tab=limits`,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
