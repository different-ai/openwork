import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { ACME_REPLY } from "../../worlds/lib/acme-gateway.ts";
import { gatewayCursorSetupWorld } from "../worlds/gateway-cursor-setup.ts";
import { isRecord } from "../worlds/library.ts";

const test = spec.world(gatewayCursorSetupWorld, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

function modelIds(body: unknown): string[] {
  return isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord).map((entry) => String(entry.id)) : [];
}

function chatText(body: unknown): string {
  const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices.filter(isRecord)[0] : undefined;
  return choice && isRecord(choice.message) && typeof choice.message.content === "string" ? choice.message.content : "";
}

function responseText(body: unknown): string {
  const output = isRecord(body) && Array.isArray(body.output) ? body.output.filter(isRecord) : [];
  return output.flatMap((item) => Array.isArray(item.content) ? item.content.filter(isRecord) : []).map((part) => typeof part.text === "string" ? part.text : "").join("");
}

test("a member creates a key, picks Cursor under Start using this key, and Cursor's requests with what they copied get a reply", async ({ world, user, probe, step, evidence }) => {
  let key = "";
  let baseUrl = "";
  let modelName = "";

  await step("the member creates a key named Cursor in My Library › Models", async () => {
    await user.see({ testId: "library-gateway-api-keys" }, { timeoutMs: 60_000 });
    await user.click({ testId: "gateway-api-keys-create" });
    await user.see({ testId: "gateway-api-key-dialog" }, { timeoutMs: 15_000 });
    await user.type({ role: "textbox", label: "Name" }, "Cursor");
    await user.click({ testId: "gateway-api-key-submit" });
  });

  await step("the next screen is Start using this key: the key once, then a choice of tools, no URLs yet", async () => {
    await user.see({ testId: "gateway-api-key-start" }, { timeoutMs: 30_000 });
    await user.see({ text: "Start using this key" });
    key = (await probe.dom('[data-testid="gateway-api-key-secret"]')).elements[0]?.text ?? "";
    const tools = (await probe.dom("[data-gateway-tool]")).elements.map((element) => element.text.split("\n")[0] ?? element.text);
    const urls = (await probe.dom('[data-testid="gateway-api-key-dialog"] code:not([data-testid="gateway-api-key-secret"])')).elements.length;
    evidence.recordAssertionEvidence("the key, then tools", `key ${key.slice(0, 10)}…; tools ${tools.join(", ")}; URLs shown ${urls}`, /^ow_gw_/.test(key) && urls === 0 && tools.length === 4);
    expect(key).toMatch(/^ow_gw_/);
    expect(urls).toBe(0);
    expect(tools.join(" ")).toMatch(/Cursor.*OpenAI Codex.*Claude Code.*Another tool/s);
    await user.screenshot();
  });

  await step("picking Cursor shows its steps: the key, the base URL and every model's name to copy", async () => {
    await user.click({ testId: "gateway-tool-cursor" });
    await user.see({ testId: "gateway-tool-cursor" }, { timeoutMs: 15_000 });
    await user.see({ testId: "cursor-model-name" }, { timeoutMs: 30_000 });
    const shownKey = (await probe.dom('[data-testid="gateway-tool-api-key"]')).elements[0]?.text ?? "";
    baseUrl = (await probe.dom('[data-testid="cursor-setup-base-url-value"]')).elements[0]?.text ?? "";
    modelName = (await probe.dom('[data-testid="cursor-model-name"]')).elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("what the member pastes into Cursor", `key matches=${shownKey === key}; base URL ${baseUrl}; model name ${modelName}`, shownKey === key && baseUrl === `${world.gatewayUrl}/api/v1/cursor` && /^openwork\/[a-z0-9.-]+-[0-9a-z]{4}$/.test(modelName));
    expect(shownKey).toBe(key);
    expect(baseUrl).toBe(`${world.gatewayUrl}/api/v1/cursor`);
    expect(modelName).toMatch(/^openwork\/[a-z0-9.-]+-[0-9a-z]{4}$/);
    await user.screenshot();
  });

  await step("with that key, base URL and name, Chat Completions and Responses requests reach the Anthropic model", async () => {
    const models = await world.callAsCursor(key, `${baseUrl}/models`);
    const chat = await world.callAsCursor(key, `${baseUrl}/chat/completions`, {
      model: modelName,
      messages: [{ role: "user", content: "Is the gateway working?" }],
      tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    });
    const responses = await world.callAsCursor(key, `${baseUrl}/responses`, { model: modelName, input: "Is the gateway working?" });
    const typed = await world.callAsCursor(key, `${baseUrl}/chat/completions`, { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    evidence.recordAssertionEvidence(
      "Cursor's requests work with what the dialog gave",
      `GET models ${models.status}, lists ${modelName}=${modelIds(models.json).includes(modelName)}; chat ${chat.status}: "${chatText(chat.json)}"; responses ${responses.status}: "${responseText(responses.json)}"; a name that isn't ours ${typed.status}`,
      models.status === 200 && chat.status === 200 && responses.status === 200 && typed.status === 400,
    );
    expect(modelIds(models.json)).toContain(modelName);
    expect(chatText(chat.json)).toBe(ACME_REPLY);
    expect(isRecord(responses.json) ? responses.json.object : null).toBe("response");
    expect(responseText(responses.json)).toBe(ACME_REPLY);
    expect(typed.status).toBe(400);
  });

  await step("back to the tools, Another tool shows the key, both base URLs and the model ids", async () => {
    await user.click({ text: "Choose another tool" });
    await user.see({ testId: "gateway-tool-picker" }, { timeoutMs: 15_000 });
    await user.click({ testId: "gateway-tool-other" });
    await user.see({ testId: "gateway-tool-other" }, { timeoutMs: 15_000 });
    await user.see({ text: world.provider.modelId });
    const openai = (await probe.dom('[data-testid="gateway-tool-other"] [data-testid="gateway-api-keys-base-url-openai"]')).elements[0]?.text ?? "";
    expect(openai).toBe(`${world.gatewayUrl}/api/v1`);
    await user.screenshot();
    await user.click({ testId: "gateway-api-key-done" });
  });

  await step("Set up Cursor (from the Library) lists the same model names without showing a key", async () => {
    await user.click({ testId: "gateway-api-keys-cursor-setup" });
    await user.see({ testId: "cursor-setup" }, { timeoutMs: 60_000 });
    await user.see({ text: modelName }, { timeoutMs: 30_000 });
    const keys = (await probe.dom('[data-testid="gateway-tool-api-key"]')).elements.length;
    expect(keys).toBe(0);
    await user.screenshot();
  });

  await step("an owner whose sign-in is old turns 3rd party tools off and is asked to confirm it's them", async () => {
    await world.ageSessions();
    await user.navigate(world.apiKeysTabUrl);
    await user.see({ testId: "gateway-api-keys-setting" }, { timeoutMs: 60_000 });
    await user.click({ role: "switch", label: "Allow 3rd party tools & harnesses" });
    await user.see({ role: "dialog", label: /Confirm your identity/ }, { timeoutMs: 15_000 });
    const inline = (await probe.dom('[data-testid="gateway-api-keys-setting"] [role="alert"]')).elements.length;
    evidence.recordAssertionEvidence("the sign-in check opens instead of an inline error", `security dialog shown; inline errors ${inline}`, inline === 0);
    expect(inline).toBe(0);
    await user.screenshot();
  });
});
