import { allocateFreePorts } from "@openwork/cdp";
import { faultProxy, type Place, type Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { isRecord } from "./library.ts";

/** Real Den + headless Den web, with a synthetic saved credential and a canonical HTTP fault proxy. No inference. */
async function credentialRemovalWorld(seed: Seed, { place }: { place: Place }, enabled: boolean) {
  await using setup = new AsyncDisposableStack();
  const localPorts = place.kind === "local" ? await allocateFreePorts(2) : null;
  const [apiPort, webPort] = localPorts ?? [];
  const pinned = apiPort && webPort
    ? setup.use(await faultProxy({ apiUrl: `http://127.0.0.1:${apiPort}`, webUrl: `http://127.0.0.1:${apiPort}` }, { place }))
    : null;
  const den = setup.use(await seed.den({
    web: true, org: { name: "Credential removal proof", admin: { name: "Provider owner" } },
    ...(pinned && apiPort && webPort ? { ports: { api: apiPort, web: webPort }, webApiBase: pinned.ref.webUrl } : {}),
  }));
  if (enabled) await enableOrganizationCapabilities(seed, den.admin, { legacyProviderCredentialRemoval: true });
  const created = await seed.api(den.admin, "/v1/llm-providers", {
    method: "POST", body: JSON.stringify({
      name: "Shared custom provider", source: "custom", credentialMode: "shared", apiKey: "synthetic-organization-credential", allMembers: true,
      customConfig: { id: "fixture-provider", name: "Shared custom provider", npm: "@ai-sdk/openai-compatible", env: ["FIXTURE_TEAM_API_KEY"],
        api: "https://inference.example.invalid/v1", models: [{ id: "fixture-model", name: "Fixture model" }] },
    }),
  });
  const provider = isRecord(created.body) && isRecord(created.body.llmProvider) ? created.body.llmProvider : null;
  if (created.response.status !== 201 || typeof provider?.id !== "string") throw new Error(`Provider fixture failed: HTTP ${created.response.status}`);
  const id = provider.id;
  const endpoint = `/v1/llm-providers/${encodeURIComponent(id)}/credential`;
  const proxy = pinned ?? setup.use(await seed.faultProxy(den));
  const web = await seed.web({
    den: pinned ? den : { ...den, ref: proxy.ref }, signedInAs: den.admin,
    startPath: `/dashboard/custom-llm-providers/${encodeURIComponent(id)}`, headless: true,
    viewport: { width: 1440, height: 1000 },
  });
  const owned = setup.move();
  return {
    den, web, id, endpoint,
    removals: async () => (await proxy.requestLog()).filter((request) => request.method === "DELETE" && request.path.endsWith(endpoint)),
    async rejectRemoval() {
      for (const path of [endpoint, `/api/den${endpoint}`]) await proxy.faults.status(path, 503, { method: "DELETE", times: 1, body: { error: "service_unavailable", message: "Could not remove the saved key. Try again." } });
    },
    async delayRemoval() {
      await proxy.faults.clear();
      for (const path of [endpoint, `/api/den${endpoint}`]) await proxy.faults.latency(path, 1500, { method: "DELETE", times: 1 });
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

export const legacyProviderCredentialRemoval = (seed: Seed, context: { place: Place }) => credentialRemovalWorld(seed, context, true);
export const legacyProviderCredentialRemovalOff = (seed: Seed, context: { place: Place }) => credentialRemovalWorld(seed, context, false);
