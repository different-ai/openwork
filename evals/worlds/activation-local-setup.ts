import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { isRecord } from "./library.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * Get set up for one person working alone (the app in headless Chrome): a real Den with a single owner, whose
 * workspace on this device already has a model provider and a connection of their own. Only the model and the
 * connected server are synthetic.
 */
export async function activationLocalSetup(seed: Seed) {
  const first = { prompt: "Summarize the launch plan in one line.", reply: "The launch plan is ready to share." };
  const second = { prompt: "List the open launch questions.", reply: "Two launch questions are still open." };
  const mock = seed.mock({
    allowUnauthenticatedMcp: true,
    agentWorkloads: [first, second].map((turn) => ({ promptMarker: turn.prompt, latestUserTurn: true, finalReply: turn.reply, steps: [] })),
  });
  const { den, webPort } = await denForAppWeb(seed, {
    mocks: { agent: mock },
    org: { name: "Solo studio", admin: { name: "Sam Solo" } },
  });
  const witness = den.mocks.agent;
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("The seeded organization is missing.");
  const providerId = "activation-witness";
  const modelId = "activation-model";
  const opencode = {
    provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "Activation witness",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-activation-witness" },
      models: { [modelId]: { name: "Activation witness" } },
    } },
    // A connection the person added to this workspace themselves; Den has never heard of it.
    mcp: { "team-notes": { type: "remote", url: witness.mcpUrl, enabled: true, oauth: false } },
  };
  const side = await signedInAppWeb(seed, { den, webPort, as: "admin", name: "activation-solo", workspacePath: seed.tmpPath("activation-solo") });
  await configureProvider(seed, side.app, side.workspace.workspaceId, providerId, modelId, opencode);
  await seed.session(side.app, { title: "Launch plan" });

  return {
    app: side.app,
    first, second,
    /** An operator turns `activationLocalSetup` on or off for this organization, as /admin does. */
    async setLocalSetup(enabled: boolean) {
      const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { activationLocalSetup: enabled } }) });
      if (result.response.status !== 200) throw new Error(`Setting the feature failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
    },
    /** What Den reports for the owner (a read, never a write). */
    async activation() {
      const result = await denFetch(den.ref, "/v1/me/activation", { headers: { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": organizationId } });
      const steps = isRecord(result.body) && Array.isArray(result.body.steps) ? result.body.steps.filter(isRecord) : [];
      return { status: result.response.status, steps, done: steps.filter((step) => step.done === true).map((step) => String(step.id)) };
    },
  };
}
