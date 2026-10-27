import { allocateFreePort } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { modelProbeFixture } from "../../ee/apps/headless-runner/scripts/model-probe-fixture.ts";
import { bootWorkbot } from "../../worlds/lib/workbot.ts";
import { isolatedRedis } from "./isolated-redis.ts";

const REPLY = "Here is what I can help Acme with today.";

/**
 * Real Workbot (chat.openworklabs.com), Den sign-in, AI Gateway assignment and runner. Only the outside model provider
 * is a local fixture, served where Den hands out the Gateway. Nobody is signed in yet: the browser starts as a
 * visitor, and the person who signs in is the seeded Acme owner.
 */
export async function webSignInGate(seed: Seed) {
  const resources = new AsyncDisposableStack();
  try {
    const redis = resources.use(await isolatedRedis());
    const port = await allocateFreePort();
    const gatewayUrl = `http://127.0.0.1:${port}`;
    const provider = await modelProbeFixture({ protocol: "openai-responses", providerPort: port, acceptKey: key => key.startsWith("ow_gw_"), answer: REPLY });
    resources.defer(() => provider.close());
    const world = await bootWorkbot(resources, undefined, { live: false, denEnv: {
      // Deployment cache keys cannot be shared across other local worlds' disposable MySQL databases.
      DATABASE_REDIS_URL: redis.url,
      GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl, GATEWAY_EGRESS_ALLOWED_ORIGINS: gatewayUrl,
    } });
    const assigned = await seed.api(world.den.admin, "/v1/inference-providers", {
      method: "POST", headers: { "x-openwork-org-id": world.orgId },
      body: JSON.stringify({ name: "Acme OpenAI", providerId: "openai", modelIds: ["gpt-6-luna"], settings: { upstreamBaseUrl: `${gatewayUrl}/v1` },
        credential: { kind: "api_key", secret: "fixture-model-key" }, allMembers: true }),
    });
    if (!assigned.response.ok) throw new Error(`Assigning Workbot's model failed: HTTP ${assigned.response.status} ${assigned.text.slice(0, 300)}`);
    const web = await seed.web({ den: world.den, headless: true, viewport: { width: 1280, height: 900 } });
    const stack = resources.move();
    return {
      web, url: world.workbotUrl, reply: REPLY,
      person: { email: world.den.admin.email, password: world.den.admin.password },
      /** Completions the model provider answered for Workbot. */
      completions: () => provider.calls().length,
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
