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

test("a member opens Set up Cursor, copies the base URL and a model name, and Cursor's requests get a reply from that model through Chat Completions and Responses", async ({ world, user, probe, step, evidence }) => {
  let baseUrl = "";
  let modelName = "";

  await step("My Library › Models offers Set up Cursor next to the API keys", async () => {
    await user.see({ testId: "library-gateway-api-keys" }, { timeoutMs: 60_000 });
    await user.see({ testId: "gateway-api-keys-cursor-setup" }, { text: "Set up Cursor" });
    await user.screenshot();
  });

  await step("Set up Cursor shows the base URL to paste and a short name for the member's model", async () => {
    await user.click({ testId: "gateway-api-keys-cursor-setup" });
    await user.see({ testId: "cursor-setup" }, { timeoutMs: 60_000 });
    await user.see({ testId: "cursor-model-name" }, { timeoutMs: 30_000 });
    baseUrl = (await probe.dom('[data-testid="cursor-setup-base-url-value"]')).elements[0]?.text ?? "";
    modelName = (await probe.dom('[data-testid="cursor-model-name"]')).elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("what the member pastes into Cursor", `base URL ${baseUrl}; model name ${modelName}`, baseUrl === `${world.gatewayUrl}/api/v1/cursor` && /^openwork\/[a-z0-9.-]+-[0-9a-z]{4}$/.test(modelName));
    expect(baseUrl).toBe(`${world.gatewayUrl}/api/v1/cursor`);
    expect(modelName).toMatch(/^openwork\/[a-z0-9.-]+-[0-9a-z]{4}$/);
    await user.screenshot();
  });

  await step("with the member's key, that base URL and that name, an OpenAI chat request reaches the Anthropic model and answers as Chat Completions", async () => {
    const key = await world.createApiKey("Cursor");
    const models = await world.callAsCursor(key, `${baseUrl}/models`);
    const ids = modelIds(models.json);
    const reply = await world.callAsCursor(key, `${baseUrl}/chat/completions`, {
      model: modelName,
      messages: [{ role: "user", content: "Is the gateway working?" }],
      // Cursor's flat tool shape.
      tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    });
    const text = chatText(reply.json);
    // Cursor may send a model through the Responses API instead.
    const viaResponses = await world.callAsCursor(key, `${baseUrl}/responses`, { model: modelName, input: "Is the gateway working?" });
    const responsesText = responseText(viaResponses.json);
    const typed = await world.callAsCursor(key, `${baseUrl}/chat/completions`, { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    evidence.recordAssertionEvidence(
      "Cursor's requests work with what the page gave",
      `GET ${baseUrl}/models ${models.status}, lists ${modelName}=${ids.includes(modelName)}; POST chat/completions ${reply.status}: "${text}"; POST responses ${viaResponses.status}: "${responsesText}"; a name that isn't ours ${typed.status}: ${typed.text.slice(0, 120)}`,
      models.status === 200 && ids.includes(modelName) && reply.status === 200 && text === ACME_REPLY && viaResponses.status === 200 && responsesText === ACME_REPLY && typed.status === 400,
    );
    expect(models.status).toBe(200);
    expect(ids).toContain(modelName);
    expect(reply.status).toBe(200);
    expect(isRecord(reply.json) ? reply.json.object : null).toBe("chat.completion");
    expect(text).toBe(ACME_REPLY);
    expect(isRecord(viaResponses.json) ? viaResponses.json.object : null).toBe("response");
    expect(responsesText).toBe(ACME_REPLY);
    expect(typed.status).toBe(400);
  });
});
