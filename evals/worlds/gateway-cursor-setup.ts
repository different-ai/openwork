import type { Seed } from "@openwork/env";
import { gatewayEnvironment, seedAcmeGateway, startAcmeGateway, startAcmeUpstream } from "../../worlds/lib/acme-gateway.ts";
import { isRecord } from "./library.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/**
 * Cursor setup (`gatewayCursorSetup`): a real Den (cloud) and AI Gateway with one Anthropic-protocol
 * provider whose only upstream is the deterministic Acme mock, every member allowed its model, member
 * API keys and Cursor setup on for the seeded organization, 3rd party tools allowed, and the owner
 * signed in on My Library › Models.
 */
export async function gatewayCursorSetupWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const upstream = await startAcmeUpstream(stack);
    const gateway = await gatewayEnvironment(upstream.baseUrl);
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud" };
    const den = stack.use(await seed.den({ env, org: { name: "Cursor setup proof", admin: { name: "Cursor owner" } } }));
    if (!den.database) throw new Error("The Cursor setup world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const provider = await seedAcmeGateway(den.admin, upstream);
    const organizationId = await enableOrganizationCapabilities(seed, den.admin, { gatewayMemberApiKeys: true, gatewayCursorSetup: true });
    const allowed = await seed.api(den.admin, "/v1/org/ai-gateway-settings", { method: "PUT", body: JSON.stringify({ memberApiKeys: true }) });
    if (!allowed.response.ok) throw new Error(`Allowing 3rd party tools failed: HTTP ${allowed.response.status} ${allowed.text.slice(0, 300)}`);
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/library?show=models", headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den,
      web,
      organizationId,
      provider,
      upstream,
      gatewayUrl: gateway.baseUrl,
      /** A key for Cursor, created as the owner would in My Library › Models. */
      async createApiKey(name: string): Promise<string> {
        const created = await seed.api(den.admin, "/v1/org/ai-gateway/api-keys/mine", { method: "POST", body: JSON.stringify({ name }) });
        const key = isRecord(created.body) ? created.body.key : null;
        if (!created.response.ok || typeof key !== "string") throw new Error(`Creating the API key failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
        return key;
      },
      /** A request as Cursor sends it: the OpenAI key header and an absolute URL under the base URL it was given. */
      async callAsCursor(key: string, url: string, body?: unknown) {
        const response = await fetch(url, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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
