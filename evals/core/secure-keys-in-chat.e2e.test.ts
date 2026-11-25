import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { CONNECT_PROMPT, GATEWAY_PROMPT, secureKeysInChat } from "../worlds/secure-keys-in-chat.ts";

const test = spec.world(secureKeysInChat, {
  timeout: 900_000,
  resources: { surfaces: ["appWeb", "web"], services: ["den", "mock"] },
});

const card = '[data-testid="credential-prompt-card"]';
const keyField = { label: "API key" };

/** Text inside the card's one state line, which also names the audience. */
function within(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("an admin adds a key-protected service and an AI Gateway provider by entering keys privately in chat", async ({ world, user, probe, step, evidence }) => {
  await step("before: the agent sets up the service by its stable key without the key, and a private field appears in the chat", async () => {
    await world.scriptConnection();
    await user.type("composer", CONNECT_PROMPT, { verify: true });
    await user.click({ role: "button", label: "Run task" });
    await user.see({ text: "Add the API key for Status service" }, { timeoutMs: 120_000 });
    await user.see({ text: "Add the key in the field above and I'll continue." }, { timeoutMs: 60_000 });
    await user.see({ text: within(`sent only to ${world.statusUrl}`) });
    const cards = (await probe.dom(card)).elements;
    expect(cards).toHaveLength(1);
    const created = await world.connection();
    expect(isRecord(created) && created.connected).toBe(false);
    evidence.recordAssertionEvidence("The service waits for a privately entered key", `Private key cards: ${cards.length}; connected: ${isRecord(created) && created.connected}`, cards.length === 1 && (isRecord(created) && created.connected) === false);
    await user.screenshot();
  });

  await step("the agent cannot send a key itself, to a connection or to a custom LLM provider", async () => {
    const smuggled: { name: string; body: Record<string, unknown> }[] = [
      { name: "postMcpConnections", body: { name: "Smuggled", url: world.statusUrl, authType: "apikey", credentialMode: "shared", apiKey: world.keys.wrong, access: { orgWide: true } } },
      { name: "postLlmProviders", body: { name: "Smuggled provider", providerId: "openai", apiKey: world.keys.wrong } },
    ];
    const refusals: boolean[] = [];
    for (const { name, body } of smuggled) {
      const attempt = await world.agentMcp("execute_capability", { name, body });
      expect(isRecord(attempt.body) ? attempt.body.error : null, name).toBe("secure_entry_required");
      expect(attempt.text.includes(world.keys.wrong)).toBe(false);
      refusals.push(isRecord(attempt.body) && attempt.body.error === "secure_entry_required" && !attempt.text.includes(world.keys.wrong));
    }
    evidence.recordAssertionEvidence("An agent cannot submit a key on the person's behalf", `${refusals.filter(Boolean).length}/${smuggled.length} submissions refused without repeating the key`, refusals.length === smuggled.length && refusals.every(Boolean));
  });

  await step("typing keeps the key hidden; it shows only while typing and asked for", async () => {
    await user.type(keyField, world.keys.wrong, { sensitive: true });
    expect((await probe.dom(`${card} input[type="password"]`)).elements).toHaveLength(1);
    await user.click({ role: "button", label: "Show while typing" });
    expect((await probe.dom(`${card} input[type="text"]`)).elements).toHaveLength(1);
    await user.click({ role: "button", label: "Hide" });
    const masked = (await probe.dom(`${card} input[type="password"]`)).elements;
    expect(masked).toHaveLength(1);
    evidence.recordAssertionEvidence("The person can reveal the key while typing and hide it again", `Masked fields after Hide: ${masked.length}`, masked.length === 1);
    await user.screenshot();
  });

  await step("a key the service rejects is not kept and never repeated", async () => {
    await user.click({ role: "button", label: "Save key" });
    await user.see({ text: "Status service didn't accept this key. Check it and try again." }, { timeoutMs: 60_000 });
    expect((await probe.text()).includes(world.keys.wrong)).toBe(false);
    const rejected = world.wire.filter((entry) => entry.identity === world.fingerprint(world.keys.wrong) && entry.status === 401);
    expect(rejected.length).toBeGreaterThan(0);
    const after = await world.connection();
    expect(isRecord(after) && after.connected).toBe(false);
    evidence.recordAssertionEvidence("A rejected key leaves the service disconnected", `Rejected requests: ${rejected.length}; connected: ${isRecord(after) && after.connected}`, rejected.length > 0 && (isRecord(after) && after.connected) === false);
    await user.screenshot();
  });

  await step("after: the right key is saved, the agent continues on its own and the service answers", async () => {
    await user.type(keyField, world.keys.status, { sensitive: true });
    await user.click({ role: "button", label: "Save key" });
    await user.see({ text: "Status service: key saved" }, { timeoutMs: 60_000 });
    await user.see({ text: world.proof }, { timeoutMs: 120_000 });
    const accepted = world.wire.filter((entry) => entry.identity === world.fingerprint(world.keys.status) && entry.status === 200);
    const toolCalls = accepted.filter((entry) => entry.method === "tools/call").length;
    expect(accepted.length).toBeGreaterThan(0);
    expect(toolCalls).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("The saved key lets the service answer a tool call",
      JSON.stringify({ accepted: accepted.length, toolCalls }), accepted.length > 0 && toolCalls > 0);
    await user.screenshot();
  });

  await step("the key never reached the transcript, the model, or Den's log", async () => {
    const page = await probe.text();
    const calls = await world.mock.agentRequests();
    const log = await world.den.apiLog();
    const leaks = [page, log].filter((text) => [world.keys.status, world.keys.wrong].some((key) => text.includes(key))).length;
    const modelSaw = calls.filter((call) => call.privateSentinelSeen).length;
    expect(calls.length).toBeGreaterThan(0);
    expect(modelSaw).toBe(0);
    expect(leaks).toBe(0);
    evidence.recordAssertionEvidence("Private keys stay out of the transcript, model requests, and server log",
      JSON.stringify({ modelCalls: calls.length, modelSaw, leaks }), calls.length > 0 && modelSaw === 0 && leaks === 0);
  });

  await step("a member without Manage connections cannot change the shared key", async () => {
    const created = await world.connection();
    const id = isRecord(created) ? created.id : null;
    if (typeof id !== "string") throw new Error("Missing connection");
    const attempt = await world.memberSavesSharedKey(id);
    expect(attempt.response.status).toBe(403);
    expect(attempt.text.includes(world.keys.wrong)).toBe(false);
    evidence.recordAssertionEvidence("A member without access cannot replace the shared key", `Save response: ${attempt.response.status}; key repeated: ${attempt.text.includes(world.keys.wrong)}`, attempt.response.status === 403 && !attempt.text.includes(world.keys.wrong));
  });

  await step("the admin adds an AI Gateway provider the same way", async () => {
    await world.scriptGateway();
    await user.type("composer", GATEWAY_PROMPT, { replace: true, verify: true });
    await user.click({ role: "button", label: "Run task" });
    await user.see({ text: "Add the API key for Team OpenRouter" }, { timeoutMs: 120_000 });
    await user.see({ text: "Add the OpenRouter key in the field above and I'll finish." }, { timeoutMs: 60_000 });
    await user.see({ text: within("sent only to https://openrouter.ai/api/v1") });
    await user.screenshot();
    const cards = (await probe.dom(`${card}[data-credential-prompt="gateway_provider_key"] input`)).elements;
    expect(cards).toHaveLength(1);
    // The status service's card is saved and has no field, so this is the only one.
    await user.type(keyField, world.keys.gateway, { sensitive: true });
    await user.click({ role: "button", label: "Save key" });
    await user.see({ text: "Team OpenRouter: key saved" }, { timeoutMs: 60_000 });
    await user.see({ text: "Team OpenRouter is ready for everyone." }, { timeoutMs: 120_000 });
    const provider = await world.gatewayProvider();
    const sets = provider ? (isRecord(provider.body) && isRecord(provider.body.inferenceProvider) ? provider.body.inferenceProvider.credentialSets : null) : null;
    const ready = Array.isArray(sets) && sets.some((set) => isRecord(set) && set.credentialMode === "org" && set.credentialStatus === "ready");
    expect(ready).toBe(true);
    expect(provider?.text.includes(world.keys.gateway)).toBe(false);
    const modelSaw = (await world.mock.agentRequests()).filter((call) => call.privateSentinelSeen).length;
    expect(modelSaw).toBe(0);
    evidence.recordAssertionEvidence("The gateway provider becomes ready without exposing its key", `Shared credential ready: ${ready}; model requests containing a key: ${modelSaw}`, ready && !provider?.text.includes(world.keys.gateway) && modelSaw === 0);
    await user.screenshot();
  });
});
