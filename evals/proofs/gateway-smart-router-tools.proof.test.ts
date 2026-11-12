import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { ACME_MODEL, ACME_REPLY } from "../../worlds/lib/acme-gateway.ts";
import { gatewaySmartRouterToolsWorld } from "../worlds/gateway-smart-router-tools.ts";
import { isRecord } from "../worlds/library.ts";

const test = spec.world(gatewaySmartRouterToolsWorld, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

function ids(body: unknown, field: "data" | "models", key: "id" | "slug"): string[] {
  return isRecord(body) && Array.isArray(body[field]) ? body[field].filter(isRecord).map((entry) => String(entry[key])) : [];
}

function chatText(body: unknown): string {
  const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices.filter(isRecord)[0] : undefined;
  return choice && isRecord(choice.message) && typeof choice.message.content === "string" ? choice.message.content : "";
}

function responseText(body: unknown): string {
  const output = isRecord(body) && Array.isArray(body.output) ? body.output.filter(isRecord) : [];
  return output.flatMap((item) => Array.isArray(item.content) ? item.content.filter(isRecord) : []).map((part) => typeof part.text === "string" ? part.text : "").join("");
}

function messageText(body: unknown): string {
  return isRecord(body) && Array.isArray(body.content) ? body.content.filter(isRecord).map((block) => typeof block.text === "string" ? block.text : "").join("") : "";
}

test("a member's Smart Router shows in the Cursor setup and in every tool's model list, and a request by its name gets an answer through Smart", async ({ world, user, probe, step, evidence }) => {
  let key = "";
  let smartName = "";

  await step("the member creates a key, picks Cursor, and chooses Smart: Engineering in the model list", async () => {
    await user.see({ testId: "library-gateway-api-keys" }, { timeoutMs: 60_000 });
    await user.click({ testId: "gateway-api-keys-create" });
    await user.see({ testId: "gateway-api-key-dialog" }, { timeoutMs: 15_000 });
    await user.type({ role: "textbox", label: "Name" }, "Tools");
    await user.click({ testId: "gateway-api-key-submit" });
    await user.see({ testId: "gateway-api-key-start" }, { timeoutMs: 30_000 });
    key = (await probe.dom('[data-testid="gateway-api-key-secret"]')).elements[0]?.text ?? "";
    await user.click({ testId: "gateway-tool-cursor" });
    await user.see({ testId: "cursor-model-name" }, { timeoutMs: 30_000 });
    await user.click({ role: "button", label: "Model" });
    await user.click({ role: "option", label: "Smart: Engineering" });
    await user.see({ text: /^openwork\/smart-engineering-[0-9a-z]{4}$/ }, { timeoutMs: 15_000 });
    smartName = (await probe.dom('[data-testid="cursor-model-name"]')).elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("the Smart Router's name for Cursor", `key ${key.slice(0, 10)}…; Smart name ${smartName}; ends with the router id's last 4=${smartName.endsWith(world.routerId.slice(-4).toLowerCase())}`, /^ow_gw_/.test(key) && smartName === `openwork/smart-engineering-${world.routerId.slice(-4).toLowerCase()}`);
    expect(key).toMatch(/^ow_gw_/);
    expect(smartName).toBe(`openwork/smart-engineering-${world.routerId.slice(-4).toLowerCase()}`);
    await user.screenshot();
  });

  await step("with that key, Cursor, Claude Code, Codex and the general model list all list the router", async () => {
    const base = `${world.gatewayUrl}/api/v1`;
    const cursor = ids((await world.call(key, `${base}/cursor/models`)).json, "data", "id");
    const claude = ids((await world.call(key, `${base}/claude-code/v1/models`, undefined, { "anthropic-version": "2023-06-01" })).json, "data", "id");
    const codex = ids((await world.call(key, `${base}/codex/models?client_version=0.130.0`)).json, "models", "slug");
    const general = ids((await world.call(key, `${base}/models`)).json, "data", "id");
    evidence.recordAssertionEvidence(
      "the model lists",
      `Cursor ${cursor.join(", ")}; Claude Code ${claude.join(", ")}; Codex ${codex.join(", ")}; general ${general.join(", ")}`,
      cursor.includes(smartName) && claude.includes(smartName) && codex.includes(smartName) && general.includes(`openwork-smart-${world.routerId}`),
    );
    expect(cursor).toContain(smartName);
    expect(claude).toContain(smartName);
    expect(codex).toContain(smartName);
    expect(general).toContain(`openwork-smart-${world.routerId}`);
  });

  await step("a request by the Smart name gets the Acme model's answer through Smart, on each tool's API", async () => {
    const base = `${world.gatewayUrl}/api/v1`;
    const before = world.upstream.requests.length;
    const chat = await world.call(key, `${base}/cursor/chat/completions`, { model: smartName, messages: [{ role: "user", content: "Is the gateway working?" }] });
    const responses = await world.call(key, `${base}/cursor/responses`, { model: smartName, input: "Is the gateway working?" });
    const messages = await world.call(key, `${base}/claude-code/v1/messages`, { model: smartName, max_tokens: 256, messages: [{ role: "user", content: "Is the gateway working?" }] }, { "anthropic-version": "2023-06-01" });
    const messagesStream = await world.call(key, `${base}/claude-code/v1/messages`, { model: smartName, max_tokens: 256, stream: true, messages: [{ role: "user", content: "Is the gateway working?" }] }, { "anthropic-version": "2023-06-01" });
    const codex = await world.call(key, `${base}/codex/responses`, {
      model: smartName, stream: true, store: false, reasoning: { effort: "medium" },
      instructions: "You are Codex.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Is the gateway working?" }] }],
      tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: { command: { type: "string" } } } }],
    });
    const routed = chat.headers.get("x-openwork-auto-model");
    const upstream = world.upstream.requests.slice(before);
    evidence.recordAssertionEvidence(
      "Smart answers on every tool endpoint",
      `Cursor chat ${chat.status} (Smart chose ${routed}, reason ${chat.headers.get("x-openwork-auto-reason")}): "${chatText(chat.json)}"; Cursor responses ${responses.status}: "${responseText(responses.json)}"; Claude Code ${messages.status}: "${messageText(messages.json)}"; Claude Code stream ${messagesStream.status} (${[...messagesStream.text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]).join(",")}); Codex stream ${codex.status} (completed=${codex.text.includes("event: response.completed")}); upstream saw ${upstream.length} request(s) for ${[...new Set(upstream.map((request) => request.model))].join(",")}`,
      chat.status === 200 && responses.status === 200 && messages.status === 200 && messagesStream.status === 200 && codex.status === 200,
    );
    expect(routed).toBe(ACME_MODEL);
    expect(chatText(chat.json)).toBe(ACME_REPLY);
    expect(isRecord(responses.json) ? responses.json.object : null).toBe("response");
    expect(responseText(responses.json)).toBe(ACME_REPLY);
    expect(isRecord(messages.json) ? messages.json.type : null).toBe("message");
    expect(messageText(messages.json)).toBe(ACME_REPLY);
    expect(messagesStream.text).toContain(ACME_REPLY);
    expect(messagesStream.text).toContain("event: message_stop");
    expect(codex.text).toContain(ACME_REPLY);
    expect(codex.text).toContain("event: response.completed");
    expect(upstream).toHaveLength(5);
    expect(upstream.every((request) => request.model === ACME_MODEL && request.authenticated)).toBe(true);
  });
});
