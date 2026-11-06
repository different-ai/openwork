export const supportedTargets = ["local/host"];

import { bootWorkbot, signInWorkbot } from "../../worlds/lib/workbot.ts";
import { denFetch } from "../../evals/packages/behaviors/src/den.ts";
import { inviteMember } from "../../evals/packages/env/src/den.ts";
import { recipe, runRecipe } from "../../evals/packages/env/src/recipe.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Real local Den + Workbot + headless runner, with Gateway disabled. The admin
 * configures a legacy provider but has a deliberately unusable upstream key;
 * a separate member owns the usable key. No key is printed as a world output.
 *
 * HEADLESS_TEST_GATEWAY_URL, HEADLESS_TEST_GATEWAY_KEY, HEADLESS_TEST_GATEWAY_MODEL
 * identify an authorized OpenAI-compatible test gateway (for example TrueFoundry).
 */
export const legacyHeadless = recipe("legacy-headless", async tools => {
  const gateway = process.env.HEADLESS_TEST_GATEWAY_URL?.trim().replace(/\/+$/, "");
  const key = process.env.HEADLESS_TEST_GATEWAY_KEY?.trim();
  const modelId = process.env.HEADLESS_TEST_GATEWAY_MODEL?.trim();
  if (!gateway || !key || !modelId) throw new Error("Set HEADLESS_TEST_GATEWAY_URL, HEADLESS_TEST_GATEWAY_KEY and HEADLESS_TEST_GATEWAY_MODEL");
  // The controller holds the key for the single provisioning request. Don't
  // pass it as an ambient variable to the child Den, Workbot or runner process.
  delete process.env.HEADLESS_TEST_GATEWAY_KEY;
  const world = await bootWorkbot(tools.stack, undefined, { live: false, denEnv: { GATEWAY_ENABLED: "false" } });
  const member = await inviteMember(world.den, "gateway-member", { name: "Gateway Member", email: "gateway-member@acme.test", password: "OpenWorkEval123!" });
  const headers = { authorization: `Bearer ${world.den.admin.token}`, "content-type": "application/json", "x-openwork-org-id": world.orgId };
  const roster = await denFetch(world.den.admin, "/v1/org", { headers });
  const members = record(roster.body) && Array.isArray(roster.body.members) ? roster.body.members.filter(record) : [];
  const memberId = members.find(m => record(m.user) && m.user.email === member.email)?.id;
  const ownerId = members.find(m => m.role === "owner")?.id;
  if (typeof memberId !== "string" || typeof ownerId !== "string") throw new Error("Missing fixture memberships");
  const created = await denFetch(world.den.admin, "/v1/llm-providers", { method: "POST", headers, body: JSON.stringify({
    name: "Private gateway", source: "custom", credentialMode: "per_member", allMembers: false, memberIds: [memberId, ownerId], teamIds: [],
    customConfig: { id: "headless-private-gateway", name: "Private gateway", npm: "@ai-sdk/openai-compatible", env: ["PRIVATE_GATEWAY_API_KEY"], api: gateway, models: [{ id: modelId, name: `${modelId} (private gateway)` }] },
  }) });
  const providerId = record(created.body) && record(created.body.llmProvider) ? created.body.llmProvider.id : null;
  if (!created.response.ok || typeof providerId !== "string") throw new Error(`Create provider: ${created.response.status}`);
  for (const [id, apiKey] of [[ownerId, "fixture-owner-key-must-never-be-used"], [memberId, key]]) {
    const stored = await denFetch(world.den.admin, `/v1/llm-providers/${providerId}/member-credentials/${id}`, { method: "PUT", headers, body: JSON.stringify({ apiKey }) });
    if (!stored.response.ok) throw new Error(`Provision fixture member: ${stored.response.status}`);
  }
  const settings = await denFetch(world.den.admin, "/v1/org/workbot-settings", { headers });
  const models = record(settings.body) && Array.isArray(settings.body.models) ? settings.body.models.filter(record) : [];
  const selection = models.find(m => typeof m.id === "string" && m.id.includes(providerId))?.id;
  if (typeof selection !== "string") throw new Error("Legacy provider missing from Workbot settings catalog");
  const chosen = await denFetch(world.den.admin, "/v1/org/workbot-settings", { method: "PUT", headers, body: JSON.stringify({ model: selection }) });
  if (!chosen.response.ok) throw new Error(`Choose legacy model: ${chosen.response.status}`);
  // Standard OAuth/PKCE sign-in with the real local Den and Workbot services.
  // Useful for automated UI proof; the output is kept private by world receipts.
  const signedIn = await signInWorkbot(world, { person: member });
  return {
    workbot: tools.output(world.workbotUrl, { group: "URLs" }),
    denWeb: tools.output(world.den.ref.webUrl, { group: "URLs" }),
    denApi: tools.output(world.den.ref.apiUrl, { group: "URLs" }),
    memberEmail: tools.output(member.email, { group: "Accounts" }),
    memberPassword: tools.secret(member.password, { group: "Accounts" }),
    workbotCookie: tools.secret(signedIn.cookie, { group: "Accounts", note: "real OAuth/PKCE test session; not an upstream key" }),
    model: tools.output(selection, { group: "Provider" }),
    upstreamModel: tools.output(modelId, { group: "Provider" }),
    providerId: tools.output(providerId, { group: "Provider" }),
  };
});

export default legacyHeadless;
if (import.meta.main) await runRecipe(legacyHeadless);
