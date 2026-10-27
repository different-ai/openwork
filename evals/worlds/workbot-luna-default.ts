import { allocateFreePort } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { modelProbeFixture, type ProbeFixtureMode } from "../../ee/apps/headless-runner/scripts/model-probe-fixture.ts";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a Den response object");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a Den response identity");
  return value;
}

const LUNA = "gpt-6-luna";
const OTHER = "gpt-4o-mini";

/**
 * Real Den, AI Gateway assignments and runner. Workbot's models are the owner's own Gateway assignments, so the owner
 * configures an OpenAI provider through Den's public API. Only the outside model provider is a synthetic localhost
 * fixture, served at the address Den hands out as the Gateway, so "Test model" reaches it with the member's Gateway key.
 * `gatewayReadable: false` leaves the Gateway off, so Den cannot read anyone's models.
 */
export function workbotLunaDefaultWorld(lunaAvailable: boolean, gatewayReadable = true, completion: ProbeFixtureMode = "answered") {
  return async (seed: Seed) => {
    const port = await allocateFreePort();
    const gatewayUrl = `http://127.0.0.1:${port}`;
    const runner = await modelProbeFixture({ mode: completion, protocol: "openai-responses", providerPort: port, acceptKey: key => key.startsWith("ow_gw_") });
    try {
      const den = await seed.den({
        org: { name: "Model workspace", admin: { name: "Workspace Admin" } },
        env: {
          DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "r".repeat(32),
          ...(gatewayReadable ? { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl, GATEWAY_EGRESS_ALLOWED_ORIGINS: gatewayUrl } : {}),
        },
      });
      let otherName = "GPT-4o mini";
      if (gatewayReadable) {
        const context = record((await seed.api(den.admin, "/v1/org")).body);
        const scope = { "x-openwork-org-id": text(record(context.organization).id) };
        const result = await seed.api(den.admin, "/v1/inference-providers", {
          method: "POST", headers: scope,
          body: JSON.stringify({
            name: "Fixture OpenAI", providerId: "openai", modelIds: lunaAvailable ? [LUNA, OTHER] : [OTHER],
            settings: { upstreamBaseUrl: `${gatewayUrl}/v1` },
            credential: { kind: "api_key", secret: "fixture-model-key" },
            allMembers: true,
          }),
        });
        if (!result.response.ok) throw new Error(`Fixture provider setup: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
        const listed = record(record(result.body).inferenceProvider).models;
        const models = Array.isArray(listed) ? listed.map(record) : [];
        const other = models.find(model => model.upstreamModelId === OTHER);
        if (!other) throw new Error("The fixture's other model was not usable by its owner");
        otherName = text(other.name);
      }
      const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/workbot-settings", headless: true, viewport: { width: 1280, height: 800, deviceScaleFactor: 1 } });
      return {
        web,
        otherName,
        settingsUrl: `${den.ref.webUrl}/dashboard/workbot-settings`,
        completionCount: () => runner.calls().length,
        authorizedCompletions: () => runner.calls().every(call => call.authorized),
        async [Symbol.asyncDispose]() { await runner.close(); },
      };
    } catch (error) { await runner.close(); throw error; }
  };
}
