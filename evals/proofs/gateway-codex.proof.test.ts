import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { ACME_REPLY } from "../../worlds/lib/acme-gateway.ts";
import { OPENAI_MOCK_REPLY, gatewayCodexWorld } from "../worlds/gateway-codex.ts";
import { isRecord } from "../worlds/library.ts";

const test = spec.world(gatewayCodexWorld, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

/** The `key = "value"` lines of the config the page shows, by key (the last one wins, as in TOML). */
function tomlValues(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of text.matchAll(/^([a-z_]+) = "([^"]*)"$/gm)) if (match[1]) values[match[1]] = match[2] ?? "";
  return values;
}

/** The text of a Responses event stream's completed response. */
function completedText(stream: string): string {
  const line = stream.split("\n").find((entry) => entry.startsWith("data:") && entry.includes("\"response.completed\""));
  if (!line) return "";
  const event: unknown = JSON.parse(line.slice(5));
  const output = isRecord(event) && isRecord(event.response) && Array.isArray(event.response.output) ? event.response.output : [];
  return output.filter(isRecord).flatMap((item) => Array.isArray(item.content) ? item.content.filter(isRecord).map((part) => String(part.text ?? "")) : []).join("");
}

/** Tools as Codex 0.167 sends them: functions, a namespace, a custom tool and its hosted web search. */
const CODEX_TOOLS = [
  { type: "function", name: "exec_command", description: "Runs a command", strict: false, parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
  { type: "namespace", name: "multi_agent_v1", description: "Sub-agents", tools: [{ type: "function", name: "close_agent", description: "Close an agent", strict: false, parameters: { type: "object", properties: { id: { type: "string" } } } }] },
  { type: "custom", name: "apply_patch", description: "Edit files", format: { type: "grammar", syntax: "lark", definition: "start: begin_patch hunk+ end_patch" } },
  { type: "web_search", external_web_access: false },
];

function codexRequest(model: string, effort: string | undefined) {
  return {
    model, stream: true, store: false, tool_choice: "auto", parallel_tool_calls: true, tools: CODEX_TOOLS,
    ...(effort ? { reasoning: { effort, summary: "auto" } } : {}),
    include: ["reasoning.encrypted_content"], prompt_cache_key: "thread-proof",
    client_metadata: { session_id: "thread-proof", "x-codex-turn-metadata": "{}" },
    input: [
      { type: "message", id: "msg_dev", role: "developer", content: [{ type: "input_text", text: "You are a coding agent running in the Codex CLI." }] },
      { type: "message", id: "msg_user", role: "user", content: [{ type: "input_text", text: "Is the gateway working?" }] },
    ],
  };
}

test("a member creates a key, picks Codex, and Codex's requests with that config reach an OpenAI model as they are and a Claude model translated", async ({ world, user, probe, step, evidence }) => {
  let envLine = "";
  let config: Record<string, string> = {};

  await step("the member creates a key and picks OpenAI Codex under Start using this key", async () => {
    await user.see({ testId: "library-gateway-api-keys" }, { timeoutMs: 60_000 });
    await user.click({ testId: "gateway-api-keys-create" });
    await user.see({ testId: "gateway-api-key-dialog" }, { timeoutMs: 15_000 });
    await user.type({ role: "textbox", label: "Name" }, "Codex");
    await user.click({ testId: "gateway-api-key-submit" });
    await user.see({ testId: "gateway-api-key-start" }, { timeoutMs: 30_000 });
    await user.see({ text: "Every model, in the Codex CLI" });
    await user.click({ testId: "gateway-tool-codex" });
    await user.see({ testId: "gateway-tool-codex-config" }, { timeoutMs: 30_000 });
  });

  await step("the member chooses GPT-5 Mini with high thinking; the steps show the key line and a config.toml for the Codex endpoint", async () => {
    await user.click({ role: "button", label: "Model" });
    await user.click({ role: "option", label: /GPT-5 Mini/ });
    await user.click({ role: "button", label: "Thinking level" });
    await user.click({ role: "option", label: "High thinking" });
    envLine = (await probe.dom('[data-testid="gateway-tool-codex-env"]')).elements[0]?.text ?? "";
    const text = (await probe.dom('[data-testid="gateway-tool-codex-config"]')).elements[0]?.text ?? "";
    config = tomlValues(text);
    await user.see({ text: /~\/\.codex\/config\.toml/ });
    evidence.recordAssertionEvidence(
      "the Codex steps",
      `key line ${envLine.slice(0, 36)}…; config:\n${text}`,
      config.base_url === `${world.gatewayUrl}/api/v1/codex` && config.model_provider === "openwork" && config.model_reasoning_effort === "high" && text.includes("echo $OPENWORK_API_KEY"),
    );
    expect(envLine).toMatch(/^export OPENWORK_API_KEY="ow_gw_[^"]+"$/);
    // Codex's background server keeps the key and config it started with, so the steps restart it.
    const restart = (await probe.dom('[data-testid="gateway-tool-codex-restart"]')).elements[0]?.text ?? "";
    expect(restart).toBe("codex app-server daemon restart");
    expect(config.model_provider).toBe("openwork");
    expect(config.base_url).toBe(`${world.gatewayUrl}/api/v1/codex`);
    expect(config.wire_api).toBe("responses");
    expect(config.model).toMatch(/^openwork\/gpt-5-mini-[0-9a-z]{4}$/);
    expect(config.model_reasoning_effort).toBe("high");
    expect(text).toContain("[model_providers.openwork.auth]");
    expect(text).toContain('args = ["-c", "echo $OPENWORK_API_KEY"]');
    await user.screenshot();
  });

  await step("with only those values, Codex's catalog fetch lists both models and its requests get answers from OpenAI (passed through) and Claude (translated)", async () => {
    const key = envLine.replace(/^export OPENWORK_API_KEY="/, "").replace(/"$/, "");
    const base = config.base_url ?? "";
    const catalog = await world.callAsCodex(key, `${base}/models?client_version=0.167.1`);
    const models = isRecord(catalog.json) && Array.isArray(catalog.json.models) ? catalog.json.models.filter(isRecord) : [];
    const slugs = models.map((model) => String(model.slug));
    const claude = slugs.find((slug) => slug.startsWith("openwork/claude-haiku-5.5-")) ?? "";
    const gpt = await world.callAsCodex(key, `${base}/responses`, codexRequest(config.model ?? "", config.model_reasoning_effort));
    const translated = await world.callAsCodex(key, `${base}/responses`, codexRequest(claude, "high"));
    const openai = world.openaiRequests().at(-1);
    evidence.recordAssertionEvidence(
      "Codex's requests with the config",
      `GET models ${catalog.status}: ${slugs.join(", ")} (instructions on each=${models.every((model) => typeof model.base_instructions === "string" && model.base_instructions.length > 1000)}); GPT ${gpt.status}: "${completedText(gpt.text)}"; OpenAI upstream saw ${JSON.stringify(openai)}; Claude ${translated.status}: "${completedText(translated.text)}"; Anthropic upstream saw ${JSON.stringify(world.anthropicRequests().at(-1))}`,
      catalog.status === 200 && gpt.status === 200 && translated.status === 200,
    );
    expect(slugs).toContain(config.model);
    expect(claude).not.toBe("");
    expect(gpt.text).toContain("event: response.completed");
    expect(completedText(gpt.text)).toBe(OPENAI_MOCK_REPLY);
    // Passed through: encrypted reasoning back, effort and client tools as sent; ids, telemetry and the hosted search dropped.
    expect(gpt.text).toContain("encrypted-mock");
    expect(openai).toMatchObject({ model: "gpt-5-mini", stream: true, reasoning: { effort: "high", summary: "auto" }, include: ["reasoning.encrypted_content"], inputIds: 0, clientMetadata: false });
    expect(openai?.tools).toEqual(["function:exec_command", "namespace:multi_agent_v1", "custom:apply_patch"]);
    expect(translated.text).toContain("event: response.completed");
    expect(completedText(translated.text)).toBe(ACME_REPLY);
    expect(world.anthropicRequests().at(-1)).toMatchObject({ model: "claude-haiku-5-5", authenticated: true });
  });
});

test("a member picks the Codex app: the key goes to the macOS Keychain and the same config reads it from there", async ({ world, user, probe, step, evidence }) => {
  await step("the member creates a key and picks Codex app under Start using this key", async () => {
    await user.see({ testId: "library-gateway-api-keys" }, { timeoutMs: 60_000 });
    await user.click({ testId: "gateway-api-keys-create" });
    await user.see({ testId: "gateway-api-key-dialog" }, { timeoutMs: 15_000 });
    await user.type({ role: "textbox", label: "Name" }, "Codex app");
    await user.click({ testId: "gateway-api-key-submit" });
    await user.see({ testId: "gateway-api-key-start" }, { timeoutMs: 30_000 });
    await user.see({ text: "Every model, in Codex in the ChatGPT app" });
    await user.click({ testId: "gateway-tool-codex-app" });
    await user.see({ testId: "gateway-tool-codex-app-config" }, { timeoutMs: 30_000 });
  });

  await step("the steps show the Keychain command with the key, a config whose auth reads the Keychain, and quitting the app", async () => {
    const keychain = (await probe.dom('[data-testid="gateway-tool-codex-app-keychain"]')).elements[0]?.text ?? "";
    const text = (await probe.dom('[data-testid="gateway-tool-codex-app-config"]')).elements[0]?.text ?? "";
    const config = tomlValues(text);
    await user.see({ text: /Quit ChatGPT completely/ });
    evidence.recordAssertionEvidence(
      "the Codex app steps",
      `keychain ${keychain.slice(0, 80)}…; config:\n${text}`,
      config.base_url === `${world.gatewayUrl}/api/v1/codex` && text.includes('command = "/usr/bin/security"'),
    );
    expect(keychain).toMatch(/^security add-generic-password -U -a "\$USER" -s openwork-ai-gateway -w "ow_gw_[^"]+"$/);
    expect(config.model_provider).toBe("openwork");
    expect(config.base_url).toBe(`${world.gatewayUrl}/api/v1/codex`);
    expect(config.wire_api).toBe("responses");
    expect(config.model).toMatch(/^openwork\/[a-z0-9.-]+-[0-9a-z]{4}$/);
    expect(text).toContain("[model_providers.openwork.auth]");
    expect(text).toContain('args = ["find-generic-password", "-s", "openwork-ai-gateway", "-w"]');
    expect(text).not.toContain("OPENWORK_API_KEY");
    await user.screenshot();

    // What the Keychain command stores is what the auth command returns: the key works on the endpoint.
    const key = keychain.replace(/^.* -w "/, "").replace(/"$/, "");
    const catalog = await world.callAsCodex(key, `${config.base_url}/models?client_version=0.166.0`);
    const slugs = isRecord(catalog.json) && Array.isArray(catalog.json.models) ? catalog.json.models.filter(isRecord).map((model) => String(model.slug)) : [];
    expect(catalog.status).toBe(200);
    expect(slugs).toContain(config.model);
  });
});
