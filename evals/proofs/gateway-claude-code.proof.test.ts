import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { ACME_REPLY } from "../../worlds/lib/acme-gateway.ts";
import { DEEPSEEK_MOCK_REPLY, gatewayClaudeCodeWorld } from "../worlds/gateway-claude-code.ts";
import { isRecord } from "../worlds/library.ts";

const test = spec.world(gatewayClaudeCodeWorld, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

function messageText(body: unknown): string {
  return isRecord(body) && Array.isArray(body.content) ? body.content.filter(isRecord).map((block) => typeof block.text === "string" ? block.text : "").join("") : "";
}

test("a member creates a key, picks Claude Code, and Claude Code's requests with that settings file reach a Claude and a DeepSeek model", async ({ world, user, probe, step, evidence }) => {
  let settings: Record<string, unknown> = {};
  let env: Record<string, unknown> = {};

  await step("the member creates a key and picks Claude Code under Start using this key", async () => {
    await user.see({ testId: "library-gateway-api-keys" }, { timeoutMs: 60_000 });
    await user.click({ testId: "gateway-api-keys-create" });
    await user.see({ testId: "gateway-api-key-dialog" }, { timeoutMs: 15_000 });
    await user.type({ role: "textbox", label: "Name" }, "Claude Code");
    await user.click({ testId: "gateway-api-key-submit" });
    await user.see({ testId: "gateway-api-key-start" }, { timeoutMs: 30_000 });
    await user.click({ testId: "gateway-tool-claude-code" });
    await user.see({ testId: "gateway-tool-claude-code-settings" }, { timeoutMs: 30_000 });
  });

  await step("the steps show a project settings file with the key, the Claude Code base URL and the chosen models", async () => {
    const key = (await probe.dom('[data-testid="gateway-api-key-dialog"] [data-testid="gateway-api-key-secret"]')).elements[0]?.text ?? "";
    const text = (await probe.dom('[data-testid="gateway-tool-claude-code-settings"]')).elements[0]?.text ?? "";
    const parsed: unknown = JSON.parse(text);
    settings = isRecord(parsed) ? parsed : {};
    env = isRecord(settings.env) ? settings.env : {};
    await user.see({ text: /\.claude\/settings\.local\.json/ });
    await user.see({ role: "button", label: "Main model" });
    await user.see({ role: "button", label: "Fast model" });
    evidence.recordAssertionEvidence(
      "the settings file",
      `ANTHROPIC_BASE_URL ${String(env.ANTHROPIC_BASE_URL)}; token is the key=${env.ANTHROPIC_AUTH_TOKEN === key || key === ""}; ANTHROPIC_API_KEY "${String(env.ANTHROPIC_API_KEY)}"; Sonnet slot ${String(env.ANTHROPIC_DEFAULT_SONNET_MODEL)}; modelOverrides ${JSON.stringify(settings.modelOverrides)}`,
      env.ANTHROPIC_BASE_URL === `${world.gatewayUrl}/api/v1/claude-code` && env.ANTHROPIC_API_KEY === "" && typeof env.ANTHROPIC_AUTH_TOKEN === "string" && env.ANTHROPIC_AUTH_TOKEN.startsWith("ow_gw_"),
    );
    expect(env.ANTHROPIC_BASE_URL).toBe(`${world.gatewayUrl}/api/v1/claude-code`);
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(String(env.ANTHROPIC_AUTH_TOKEN)).toMatch(/^ow_gw_/);
    expect(String(env.ANTHROPIC_DEFAULT_SONNET_MODEL)).toMatch(/^openwork\/claude-haiku-5\.5-[0-9a-z]{4}/);
    expect(isRecord(settings.modelOverrides) ? Object.keys(settings.modelOverrides) : []).toContain("claude-haiku-5-5");
    await user.screenshot();
  });

  await step("with only that file's values, Claude Code's requests list the models and get answers from Claude and from DeepSeek", async () => {
    const base = String(env.ANTHROPIC_BASE_URL);
    const key = String(env.ANTHROPIC_AUTH_TOKEN);
    const models = await world.callAsClaudeCode(key, `${base}/v1/models?limit=1000`);
    const ids = isRecord(models.json) && Array.isArray(models.json.data) ? models.json.data.filter(isRecord).map((entry) => String(entry.id)) : [];
    const deepseek = ids.find((id) => id.startsWith("openwork/deepseek")) ?? "";
    const claude = await world.callAsClaudeCode(key, `${base}/v1/messages?beta=true`, { model: env.ANTHROPIC_DEFAULT_SONNET_MODEL, max_tokens: 256, messages: [{ role: "user", content: "Is the gateway working?" }] });
    const other = await world.callAsClaudeCode(key, `${base}/v1/messages?beta=true`, {
      model: deepseek, max_tokens: 1, stream: true,
      tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }],
      messages: [{ role: "user", content: "Is the gateway working?" }],
    });
    const requests = world.deepseekRequests();
    evidence.recordAssertionEvidence(
      "Claude Code's requests with the settings file",
      `GET models ${models.status}: ${ids.join(", ")}; Claude ${claude.status}: "${messageText(claude.json)}"; DeepSeek stream ${other.status} (events ${[...other.text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]).join(",")}); DeepSeek upstream saw ${JSON.stringify(requests)}`,
      models.status === 200 && claude.status === 200 && other.status === 200,
    );
    expect(ids).toContain(String(env.ANTHROPIC_DEFAULT_SONNET_MODEL));
    expect(deepseek).not.toBe("");
    expect(messageText(claude.json)).toBe(ACME_REPLY);
    expect(other.text).toContain(DEEPSEEK_MOCK_REPLY);
    expect(other.text).toContain("event: message_stop");
    expect(requests.at(-1)).toMatchObject({ model: "deepseek-v4-flash", stream: true, tools: 1 });
  });
});
