import { allocateFreePorts } from "@openwork/cdp";
import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { isRecord } from "./library.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * Get set up in the Desktop app (in headless Chrome): a real Den with an owner and a member, each signed in to their
 * own app with a deterministic local model. Get set up is generally available; only the model is synthetic.
 */
export async function activationChecklistDesktop(seed: Seed) {
  const owner = { prompt: "Summarize the launch plan in one line.", reply: "The launch plan is ready to share." };
  const member = { prompt: "List the open launch questions.", reply: "Two launch questions are still open." };
  const mock = seed.mock({
    agentWorkloads: [owner, member].map((turn) => ({ promptMarker: turn.prompt, latestUserTurn: true, finalReply: turn.reply, steps: [] })),
  });
  const [memberPort] = await allocateFreePorts(1);
  if (!memberPort) throw new Error("No port available for the member's app.");
  const { den, webPort } = await denForAppWeb(seed, {
    mocks: { agent: mock },
    org: { name: "Acme", admin: { name: "Avery Owner" }, members: { riley: { name: "Riley Member" } } },
    // Den's AI Gateway is on so an admin can share a provider; nothing calls the gateway in this world.
    env: { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:1", GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:1" },
    trustedOrigins: [`http://127.0.0.1:${memberPort}`],
  });
  const witness = den.mocks.agent;
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("The seeded organization is missing.");
  const providerId = "activation-witness";
  const modelId = "activation-model";
  const opencode = { provider: { [providerId]: {
    npm: "@ai-sdk/openai-compatible", name: "Activation witness",
    options: { baseURL: `${witness.url}/v1`, apiKey: "sk-activation-witness" },
    models: { [modelId]: { name: "Activation witness" } },
  } } };
  const ownerSide = await signedInAppWeb(seed, { den, webPort, as: "admin", name: "activation-owner", workspacePath: seed.tmpPath("activation-owner") });
  await configureProvider(seed, ownerSide.app, ownerSide.workspace.workspaceId, providerId, modelId, opencode);
  const memberSide = await signedInAppWeb(seed, { den, webPort: memberPort, as: "riley", name: "activation-member", workspacePath: seed.tmpPath("activation-member") });
  await configureProvider(seed, memberSide.app, memberSide.workspace.workspaceId, providerId, modelId, opencode);
  await seed.session(ownerSide.app, { title: "Launch plan" });
  await seed.session(memberSide.app, { title: "Launch questions" });

  const people = { admin: den.admin, riley: den.members.riley };
  return {
    app: ownerSide.app,
    memberApp: memberSide.app,
    den, organizationId, owner, member,
    /** The owner shares a provider on AI Gateway, as the AI Gateway page does. */
    async shareGatewayProvider() {
      const result = await seed.api(den.admin, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ name: "Team OpenAI", providerId: "openai", modelIds: ["gpt-4o-mini"] }) });
      if (result.response.status !== 201) throw new Error(`Sharing the provider failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
      return { status: result.response.status };
    },
    /** What Den reports for one person (a read, never a write). */
    async activation(person: keyof typeof people) {
      const session = people[person];
      if (!session) throw new Error(`Unknown person ${person}`);
      const result = await denFetch(den.ref, "/v1/me/activation", { headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": organizationId } });
      const steps = isRecord(result.body) && Array.isArray(result.body.steps) ? result.body.steps.filter(isRecord) : [];
      return { status: result.response.status, steps, done: steps.filter((step) => step.done === true).map((step) => String(step.id)) };
    },
  };
}
