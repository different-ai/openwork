import type { Seed } from "@openwork/env";
import { gatewayEnvironment, seedAcmeGateway, startAcmeGateway, startAcmeUpstream } from "../../worlds/lib/acme-gateway.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/**
 * AI Gateway API keys for 3rd party tools (`gatewayMemberApiKeys`): a real Den (cloud, the feature on for
 * the seeded organization), a real AI Gateway with one Anthropic-protocol provider whose only upstream is
 * the deterministic Acme mock, every member allowed its model, and the owner signed in on Settings › General.
 * The organization setting starts off, as for every organization.
 */
export async function gatewayMemberApiKeysWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const upstream = await startAcmeUpstream(stack);
    const gateway = await gatewayEnvironment(upstream.baseUrl);
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud" };
    const den = stack.use(await seed.den({ env, org: { name: "Gateway keys proof", admin: { name: "Keys owner" } } }));
    if (!den.database) throw new Error("The Gateway API keys world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const provider = await seedAcmeGateway(den.admin, upstream);
    const organizationId = await enableOrganizationCapabilities(seed, den.admin, { gatewayMemberApiKeys: true });
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/org-settings", headless: true, viewport: { width: 1440, height: 1100 } });
    const webUrl = den.ref.webUrl;
    return {
      den,
      web,
      organizationId,
      provider,
      upstream,
      gatewayUrl: gateway.baseUrl,
      settingsUrl: `${webUrl}/dashboard/org-settings`,
      libraryModelsUrl: `${webUrl}/dashboard/library?show=models`,
      apiKeysTabUrl: `${webUrl}/dashboard/ai-gateway?tab=api-keys`,
      /** A request to the AI Gateway as a 3rd party tool sends it: the member's key and nothing else. */
      async callGateway(key: string, path: string, body?: unknown) {
        const response = await fetch(`${gateway.baseUrl}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "x-api-key": key, ...(body === undefined ? {} : { "content-type": "application/json", "anthropic-version": "2023-06-01" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await response.text();
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { json = null; }
        return { status: response.status, json, text };
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
