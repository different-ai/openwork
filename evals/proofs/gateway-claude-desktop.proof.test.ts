import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { claudeDesktopListsModel } from "@openwork/types/den/gateway-cursor";
import { ACME_REPLY } from "../../worlds/lib/acme-gateway.ts";
import { DEEPSEEK_MOCK_REPLY, gatewayClaudeCodeWorld } from "../worlds/gateway-claude-code.ts";
import { isRecord } from "../worlds/library.ts";

// Claude Desktop's Gateway mode uses the Claude Code endpoint, so this proof runs on the Claude Code
// world: a real Den and AI Gateway with a Claude model (Acme mock) and a DeepSeek model.
const test = spec.world(gatewayClaudeCodeWorld, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

/** The headers Claude Desktop 5.1231 sends in Gateway mode with auth scheme bearer. */
function desktopHeaders(key: string, chat: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    ...(chat ? { "anthropic-beta": "interleaved-thinking-2025-05-14,claude-code-20250219", "x-app": "cli", "anthropic-client-platform": "desktop_app" } : {}),
  };
}

async function call(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
}

/** A chat as Claude Desktop sends it: the Claude Code inside it, streamed, with thinking and a tool. */
function desktopChat(model: string) {
  return {
    model, max_tokens: 32000, stream: true,
    thinking: { type: "enabled", budget_tokens: 31999 },
    system: [{ type: "text", text: "You are Claude." }, { type: "text", text: "Cowork session", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "mcp__workspace__bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
    messages: [{ role: "user", content: [{ type: "text", text: "Is the gateway working?", cache_control: { type: "ephemeral" } }] }],
  };
}

test("a member creates a key, picks Claude Desktop, and Claude Desktop's requests with the pasted values reach their Claude model", async ({ world, user, probe, step, evidence }) => {
  let baseUrl = "";
  let key = "";

  await step("the member creates a key and picks Claude Desktop under Start using this key", async () => {
    await user.see({ testId: "library-gateway-api-keys" }, { timeoutMs: 60_000 });
    await user.click({ testId: "gateway-api-keys-create" });
    await user.see({ testId: "gateway-api-key-dialog" }, { timeoutMs: 15_000 });
    await user.type({ role: "textbox", label: "Name" }, "Claude Desktop");
    await user.click({ testId: "gateway-api-key-submit" });
    await user.see({ testId: "gateway-api-key-start" }, { timeoutMs: 30_000 });
    await user.see({ testId: "gateway-tool-claude-desktop" });
    await user.screenshot();
    await user.click({ testId: "gateway-tool-claude-desktop" });
    await user.see({ testId: "gateway-tool-claude-desktop" }, { timeoutMs: 30_000 });
  });

  await step("the steps show the Gateway base URL, the key, and the Claude models Claude Desktop will list", async () => {
    const shown = (await probe.dom('[data-testid="gateway-api-key-dialog"] [data-testid="gateway-api-key-secret"]')).elements[0]?.text ?? "";
    baseUrl = (await probe.dom('[data-testid="gateway-tool-claude-desktop-base-url"]')).elements[0]?.text ?? "";
    key = (await probe.dom('[data-testid="gateway-tool-claude-desktop-api-key"]')).elements[0]?.text ?? "";
    await user.see({ text: /Configure Third-Party Inference/ });
    await user.see({ text: /Static API key/ });
    await user.see({ text: /Continue with Gateway/ });
    let models = "";
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 500))) {
      models = (await probe.dom('[data-testid="gateway-tool-claude-desktop-models"]')).elements[0]?.text ?? "";
      if (models && !/Loading/.test(models)) break;
    }
    evidence.recordAssertionEvidence(
      "Claude Desktop's steps",
      `Gateway base URL ${baseUrl}; key is the new key=${key === shown || shown === ""}; models listed "${models}"`,
      baseUrl === `${world.gatewayUrl}/api/v1/claude-code` && key.startsWith("ow_gw_") && /Claude Haiku 5\.5/.test(models) && !/DeepSeek/.test(models),
    );
    expect(baseUrl).toBe(`${world.gatewayUrl}/api/v1/claude-code`);
    expect(key).toMatch(/^ow_gw_/);
    if (shown) expect(key).toBe(shown);
    expect(models).toMatch(/Claude Haiku 5\.5/);
    expect(models).not.toMatch(/DeepSeek/);
    await user.screenshot();
  });

  await step("with only those values, Claude Desktop's model list, Test connection and a chat reach the Claude model", async () => {
    const list = await call(`${baseUrl}/v1/models?limit=1000`, { headers: desktopHeaders(key, false) });
    const ids = isRecord(list.json) && Array.isArray(list.json.data) ? list.json.data.filter(isRecord).map((entry) => String(entry.id)) : [];
    const picker = ids.filter(claudeDesktopListsModel);
    const claude = picker[0] ?? "";
    const deepseek = ids.find((id) => id.startsWith("openwork/deepseek")) ?? "";
    const probeCall = await call(`${baseUrl}/v1/messages`, { method: "POST", headers: desktopHeaders(key, false), body: JSON.stringify({ model: claude, max_tokens: 1, messages: [{ role: "user", content: "." }] }) });
    const chat = await call(`${baseUrl}/v1/messages?beta=true`, { method: "POST", headers: desktopHeaders(key, true), body: JSON.stringify(desktopChat(claude)) });
    // Claude Desktop hides other models; the same request still works when a tool sends one.
    const translated = await call(`${baseUrl}/v1/messages?beta=true`, { method: "POST", headers: desktopHeaders(key, true), body: JSON.stringify(desktopChat(deepseek)) });
    const requests = world.deepseekRequests();
    evidence.recordAssertionEvidence(
      "Claude Desktop's requests with the pasted values",
      `GET models ${list.status}: ${ids.join(", ")}; picker keeps ${picker.join(", ")}; test connection ${probeCall.status}; Claude chat ${chat.status} (events ${[...chat.text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]).join(",")}); DeepSeek (hidden in Claude Desktop) ${translated.status}; DeepSeek upstream saw ${JSON.stringify(requests)}`,
      list.status === 200 && probeCall.status === 200 && chat.status === 200 && translated.status === 200,
    );
    expect(list.status).toBe(200);
    expect(picker).toHaveLength(1);
    expect(claude).toMatch(/^openwork\/claude-haiku-5\.5-[0-9a-z]{4}/);
    expect(deepseek).not.toBe("");
    expect(picker).not.toContain(deepseek);
    expect(probeCall.status).toBe(200);
    expect(chat.status).toBe(200);
    expect(chat.text).toContain(ACME_REPLY);
    expect(chat.text).toContain("event: message_stop");
    expect(translated.text).toContain(DEEPSEEK_MOCK_REPLY);
    expect(requests.at(-1)).toMatchObject({ model: "deepseek-v4-flash", stream: true, tools: 1 });
  });
});
