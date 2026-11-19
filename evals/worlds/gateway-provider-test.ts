import type { Seed } from "@openwork/env";
import { gatewayEnvironment, startAcmeGateway, startAcmeUpstream } from "../../worlds/lib/acme-gateway.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";

/**
 * Testing a provider before adding it: a real Den with `gatewayProviderTest`
 * on for the seeded organization, a real AI Gateway, and the deterministic
 * Acme upstream (Anthropic Messages, one key) allowlisted as the operator's
 * own endpoint. The owner is signed in on AI Gateway › Add Anthropic.
 */
export async function gatewayProviderTestWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const upstream = await startAcmeUpstream(stack);
    const gateway = await gatewayEnvironment(upstream.baseUrl);
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud" };
    const den = stack.use(await seed.den({ env, org: { name: "Provider test proof", admin: { name: "Gateway owner" } } }));
    if (!den.database) throw new Error("The provider test world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const organizationId = await seededOrganizationId(seed, den.admin);
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway/providers/new?provider=anthropic", headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den,
      web,
      organizationId,
      upstream,
      /** Den's test route, as the signed-in owner (probe.api is read-only). */
      testConnection: (body: Record<string, unknown>) => seed.api(den.admin, "/v1/inference-providers/test-connection", { method: "POST", body: JSON.stringify(body) }),
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
