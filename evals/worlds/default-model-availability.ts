import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { modelRemovalHttpFixture } from "./model-removal-cdp.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Scenario = "partial" | "ready" | "removed" | "failed";

/** Real saved settings and authenticated Den UI; only options-read faults are deterministic. */
export async function defaultModelAvailability(seed: Seed) {
  await using setup = new AsyncDisposableStack();
  const den = await seed.den({ web: true });
  await enableOrganizationCapabilities(seed, den.admin, { orgDefaultModel: true });
  const created = await seed.api(den.admin, "/v1/llm-providers", { method: "POST", body: JSON.stringify({
    name: "Organization models", source: "custom", allMembers: true, memberIds: [], teamIds: [], apiKey: "synthetic-default-model-key",
    customConfig: { id: "default-model-fixture", name: "Organization models", npm: "@ai-sdk/openai-compatible", env: ["DEFAULT_MODEL_FIXTURE_KEY"],
      options: { baseURL: "http://127.0.0.1:9/v1" }, models: [{ id: "model-one", name: "Model one" }, { id: "model-two", name: "Model two" }] },
  }) });
  const provider = isRecord(created.body) && isRecord(created.body.llmProvider) ? created.body.llmProvider : null;
  if (!created.response.ok || !provider || typeof provider.id !== "string") throw new Error("Could not create the isolated organization models");
  const saved = await seed.api(den.admin, "/v1/org/default-model/everyone", { method: "PUT", body: JSON.stringify({ model: { providerId: provider.id, modelId: "model-one" } }) });
  if (!saved.response.ok) throw new Error(`Could not save the default: ${saved.response.status} ${saved.text}`);
  const inventory = await seed.api(den.admin, "/v1/org/default-model/options");
  if (!inventory.response.ok || !isRecord(inventory.body)) throw new Error("Could not read the real default-model options");
  const options = inventory.body;
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/org-settings", headless: true, viewport: { width: 1440, height: 1000 } });
  let scenario: Scenario = "partial";
  const reads: Scenario[] = [];
  const fixture = setup.use(await modelRemovalHttpFixture({ client: web.client, webUrl: den.ref.webUrl }, ["*/v1/org/default-model/options*"], url => {
    if (!url.pathname.endsWith("/v1/org/default-model/options")) return undefined;
    reads.push(scenario);
    if (scenario === "ready") return options;
    if (scenario === "failed") return { error: "source unavailable" };
    return { options: [], unavailableSources: scenario === "partial" ? ["provider"] : [] };
  }));
  const resources = setup.move();
  return { web, den, settingsUrl: new URL("/dashboard/org-settings", den.ref.webUrl).toString(),
    scenario(next: Scenario) { fixture.check(); scenario = next; },
    reads() { fixture.check(); return [...reads]; },
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}
