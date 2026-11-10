import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { ACME_REPLY } from "../../worlds/lib/acme-gateway.ts";
import { gatewayMemberApiKeysWorld } from "../worlds/gateway-member-api-keys.ts";
import { isRecord } from "../worlds/library.ts";

const test = spec.world(gatewayMemberApiKeysWorld, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

const SWITCH = { role: "switch", label: "Allow 3rd party tools & harnesses" } as const;

function replyText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.content)) return "";
  return body.content.filter(isRecord).map((part) => (typeof part.text === "string" ? part.text : "")).join("");
}

function modelIds(body: unknown): string[] {
  return isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord).map((entry) => String(entry.id)) : [];
}

test("an owner lets members use AI Gateway from 3rd party tools, creates their own key and calls a model with it", async ({ world, user, probe, step, evidence }) => {
  let key = "";

  await step("before: AI Gateway › API Keys starts with 3rd party tools off and explains that members create their own keys", async () => {
    await user.see({ testId: "gateway-api-keys-setting" }, { timeoutMs: 60_000 });
    await user.see(SWITCH);
    await user.see({ testId: "gateway-api-keys-admin-empty" }, { text: /Members create their own keys/ });
    await user.see({ testId: "gateway-api-keys-admin-off" });
    const off = await probe.dom('[role="switch"][aria-label="Allow 3rd party tools & harnesses"][aria-checked="false"]');
    const settings = await probe.api(world.den.admin, "/v1/org/ai-gateway-settings");
    evidence.recordAssertionEvidence("off for a new organization", `switch off=${off.elements.length === 1}; GET settings ${JSON.stringify(settings.body)}`, off.elements.length === 1);
    expect(off.elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("the owner allows 3rd party tools & harnesses on the same page, and is offered to create their own key", async () => {
    await user.click(SWITCH);
    const saved = await probe.eventually(() => probe.api(world.den.admin, "/v1/org/ai-gateway-settings"), {
      within: 15_000, intervalMs: 300, label: "the setting is saved", until: (result) => isRecord(result.body) && isRecord(result.body.settings) && result.body.settings.memberApiKeys === true,
    });
    await user.see({ testId: "gateway-api-keys-create-own" }, { text: "Create your own key now", timeoutMs: 15_000 });
    const on = await probe.dom('[role="switch"][aria-label="Allow 3rd party tools & harnesses"][aria-checked="true"]');
    evidence.recordAssertionEvidence("saved for the organization", `switch on=${on.elements.length === 1}; GET settings ${JSON.stringify(saved.body)}`, on.elements.length === 1);
    expect(on.elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("Create your own key now opens My Library › Models with the new key dialog already open", async () => {
    await user.click({ testId: "gateway-api-keys-create-own" });
    await user.see({ testId: "gateway-api-key-dialog" }, { timeoutMs: 60_000 });
    await user.see({ testId: "library-gateway-api-keys" });
    const route = await probe.url();
    evidence.recordAssertionEvidence("landed on Library › Models with the dialog open", route, route.includes("/dashboard/library"));
    expect(route).toContain("/dashboard/library");
    await user.screenshot();
  });

  await step("the owner names the key Claude Code, keeps the 90 day expiry, and sees the key once", async () => {
    await user.see({ testId: "gateway-api-key-dialog" }, { timeoutMs: 15_000 });
    await user.type({ role: "textbox", label: "Name" }, "Claude Code");
    await user.see({ role: "button", label: "Expires" }, { text: "In 90 days" });
    await user.screenshot();
    await user.click({ testId: "gateway-api-key-submit" });
    await user.see({ testId: "gateway-api-key-secret" }, { timeoutMs: 30_000 });
    key = (await probe.dom('[data-testid="gateway-api-key-secret"]')).elements[0]?.text ?? "";
    const mine = await probe.api(world.den.admin, "/v1/org/ai-gateway/api-keys/mine");
    const saved = isRecord(mine.body) && Array.isArray(mine.body.apiKeys) ? mine.body.apiKeys.filter(isRecord)[0] : undefined;
    const days = typeof saved?.expiresAt === "string" ? Math.round((new Date(saved.expiresAt).getTime() - Date.now()) / 86_400_000) : null;
    evidence.recordAssertionEvidence("a new AI Gateway key is shown, named and expiring", `${key.slice(0, 10)}… (${key.length} characters); name ${String(saved?.name)}; expires in ${String(days)} days`, /^ow_gw_/.test(key) && saved?.name === "Claude Code" && days === 90);
    expect(key).toMatch(/^ow_gw_/);
    expect(saved?.name).toBe("Claude Code");
    expect(days).toBe(90);
    await user.screenshot();
  });

  await step("with only that key, a tool lists the owner's models and gets a reply from one through the AI Gateway", async () => {
    await user.click({ testId: "gateway-api-key-done" });
    await user.see({ text: "Claude Code" }, { timeoutMs: 15_000 });
    const openai = (await probe.dom('[data-testid="gateway-api-keys-base-url-openai"]')).elements[0]?.text ?? "";
    const anthropic = (await probe.dom('[data-testid="gateway-api-keys-base-url-anthropic"]')).elements[0]?.text ?? "";
    expect(openai).toBe(`${world.gatewayUrl}/api/v1`);
    expect(anthropic).toBe(`${world.gatewayUrl}/api`);
    const models = await world.callGateway(key, "/api/v1/models");
    const ids = modelIds(models.json);
    const reply = await world.callGateway(key, "/api/v1/messages", { model: world.provider.modelId, max_tokens: 64, messages: [{ role: "user", content: "Is the gateway working?" }] });
    const text = replyText(reply.json);
    evidence.recordAssertionEvidence(
      "the key reaches the owner's model",
      `base URLs ${openai} and ${anthropic}; GET /api/v1/models ${models.status}, ${ids.length} model(s), includes ${world.provider.modelName}=${ids.includes(world.provider.modelId)}; POST /api/v1/messages ${reply.status}: "${text}"`,
      models.status === 200 && ids.includes(world.provider.modelId) && reply.status === 200 && text === ACME_REPLY,
    );
    expect(models.status).toBe(200);
    expect(ids).toContain(world.provider.modelId);
    expect(reply.status).toBe(200);
    expect(text).toBe(ACME_REPLY);
    await user.reload();
    await user.see({ text: /Used (just now|\d+ min ago)/ }, { timeoutMs: 30_000 });
    await user.screenshot();
  });

  await step("AI Gateway › API Keys lists the key with its owner and when it was last used", async () => {
    await user.navigate(world.apiKeysTabUrl);
    await user.see({ testId: "gateway-api-keys-admin" }, { timeoutMs: 60_000 });
    await user.see({ text: "Claude Code" });
    await user.see({ text: "Keys owner" });
    const listed = await probe.api(world.den.admin, "/v1/org/ai-gateway/api-keys");
    const keys = isRecord(listed.body) && Array.isArray(listed.body.apiKeys) ? listed.body.apiKeys.filter(isRecord) : [];
    evidence.recordAssertionEvidence("one key, the owner's", keys.map((entry) => `${String(entry.name)} by ${isRecord(entry.member) ? String(entry.member.name) : "?"}`).join(", "), keys.length === 1);
    expect(keys).toHaveLength(1);
    await user.screenshot();
  });

  await step("turning 3rd party tools off on the same tab stops the key at the AI Gateway; the key stays listed, marked not valid", async () => {
    await user.click(SWITCH);
    await user.see({ text: /These keys are currently not valid/ }, { timeoutMs: 15_000 });
    await user.see({ text: "Claude Code" });
    const refused = await probe.eventually(() => world.callGateway(key, "/api/v1/models"), {
      within: 45_000, intervalMs: 1_000, label: "the AI Gateway refuses the key", until: (result) => result.status === 401,
    });
    evidence.recordAssertionEvidence("refused while off, still listed", `GET /api/v1/models ${refused.status}: ${refused.text.slice(0, 120)}`, refused.status === 401);
    expect(refused.status).toBe(401);
    await user.screenshot();
  });
});
