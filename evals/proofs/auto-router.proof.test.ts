import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  AUTO_ROUTER_DEFAULT_PROMPT,
  AUTO_ROUTER_MODEL_ID,
  AUTO_ROUTER_PROVIDER_ID,
  AUTO_ROUTER_RESPONSE_MODEL_HEADER,
  AUTO_ROUTER_RESPONSE_REASON_HEADER,
  AUTO_ROUTER_THINKING_LABELS,
  AUTO_ROUTER_THINKING_LEVELS,
} from "@openwork/types/den/auto-router";
import { ACME_MODEL, ACME_REPLY } from "../../worlds/lib/acme-gateway.ts";
import { autoRouterDesktopWorld, autoRouterMissingKeyWorld, autoRouterWorld } from "../worlds/auto-router.ts";
import { isRecord } from "./../worlds/library.ts";

const test = spec.world(autoRouterWorld, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });
const missingKeyTest = spec.world(autoRouterMissingKeyWorld, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });
const desktopTest = spec.world(autoRouterDesktopWorld, {
  resources: { surfaces: ["appWeb"], services: ["den"] },
  // The shipping server downloads its pinned verified v2 engine if absent.
  needs: { commands: ["bun"] }, timeout: 900_000,
});

test("an admin turns on the Auto Router with a default model and Auto answers through it", async ({ world, user, probe, step, evidence }) => {
  await step("before: AI Gateway has an Auto Router tab, off until a default model is chosen", async () => {
    await user.see({ testId: "ai-gateway-panel-auto-router" }, { timeoutMs: 60_000 });
    await user.see({ role: "tab", text: "Auto Router" });
    await user.see({ testId: "auto-router-section" }, { timeoutMs: 60_000 });
    await user.see({ testId: "auto-router-enable" }, { text: "Turn on" });
    const connect = await probe.api(world.den.admin, "/v1/org/auto-router/connect");
    expect(connect.response.status).toBe(404);
    evidence.recordAssertionEvidence("desktops get no Auto before it is configured", `connect HTTP ${connect.response.status}`, connect.response.status === 404);
    await user.screenshot();
  });

  let offered: string[] = [];
  let defaultLevel = "default";
  await step("the admin turns it on by choosing the default model at one thinking level", async () => {
    await user.click({ testId: "auto-router-enable" });
    await user.see({ testId: "auto-router-editor" }, { timeoutMs: 30_000 });
    const editor = await probe.dom('[data-testid="auto-router-editor"][data-default="true"]');
    expect(editor.elements).toHaveLength(1);
    await user.see({ testId: "auto-router-prompt" }, { text: AUTO_ROUTER_DEFAULT_PROMPT });
    const prompt = await probe.dom('[data-testid="auto-router-prompt"]');
    const readOnly = prompt.elements[0]?.tag === "p";
    expect(readOnly).toBe(true);
    await user.see({ role: "combobox", label: "Model" }, { value: world.provider.modelName.replace(/ \(.*\)$/, ""), timeoutMs: 30_000 });
    const levels = await probe.dom('[data-testid^="auto-router-thinking-"]');
    offered = levels.elements.map((entry) => entry.text);
    if (offered.includes("High")) {
      defaultLevel = "high";
      await user.click({ testId: "auto-router-thinking-high" });
    }
    evidence.recordAssertionEvidence("the default model's prompt is fixed and shown read only", `prompt tag=${prompt.elements[0]?.tag ?? "none"}; text="${prompt.elements[0]?.text ?? ""}"; offered=${offered.join("/")}`, readOnly);
    await user.screenshot();
    await user.see({ testId: "auto-router-save-route" }, { text: "Turn on" });
    await user.click({ testId: "auto-router-save-route" });
    await user.see({ testId: "auto-router-route" }, { timeoutMs: 30_000 });
  });

  await step("after: the admin adds a second route with its own prompt and level", async () => {
    const secondLevel = defaultLevel === "high" ? "default" : offered.includes("Low") ? "low" : "default";
    await user.click({ testId: "auto-router-add" });
    await user.see({ testId: "auto-router-editor" }, { timeoutMs: 30_000 });
    await user.type({ testId: "auto-router-prompt" }, "Quick questions, small edits and short answers");
    await user.click({ testId: `auto-router-thinking-${secondLevel}` });
    await user.click({ testId: "auto-router-save-route" });
    const rows = await probe.eventually(() => probe.dom('[data-testid="auto-router-route"]'), {
      within: 30_000, label: "two Auto Router routes", until: (value) => value.elements.length === 2,
    });
    const saved = await probe.api(world.den.admin, "/v1/org/auto-router");
    const routes = isRecord(saved.body) && Array.isArray(saved.body.routes) ? saved.body.routes.filter(isRecord) : [];
    expect(saved.response.ok).toBe(true);
    expect(isRecord(saved.body) && saved.body.enabled).toBe(true);
    expect(routes).toHaveLength(2);
    expect(routes[0]?.isDefault).toBe(true);
    expect(routes[0]?.prompt).toBe(AUTO_ROUTER_DEFAULT_PROMPT);
    expect(routes[0]?.modelId).toBe(ACME_MODEL);
    expect(routes[0]?.thinkingLevel).toBe(defaultLevel);
    expect(routes[0]).not.toHaveProperty("thinkingLevels");
    expect(routes[1]?.isDefault).toBe(false);
    expect(routes[1]?.prompt).toBe("Quick questions, small edits and short answers");
    expect(routes[1]?.thinkingLevel).toBe(secondLevel);
    const firstRow = await probe.dom('[data-testid="auto-router-route"][data-default="true"]');
    expect(rows.elements[0]?.text).toBe(firstRow.elements[0]?.text);
    evidence.recordAssertionEvidence(
      "route 0 is the default model with the fixed prompt and one thinking level",
      routes.map((route, index) => `#${index} default=${String(route.isDefault)} model=${String(route.modelId)} level=${String(route.thinkingLevel)} prompt="${String(route.prompt)}"`).join("; "),
      routes.length === 2 && routes[0]?.isDefault === true && routes[0]?.prompt === AUTO_ROUTER_DEFAULT_PROMPT && routes[0]?.thinkingLevel === defaultLevel,
    );
    await user.screenshot();
  });

  await step("after: Auto routes a chat request to the configured model through the Gateway", async () => {
    const connect = await probe.api(world.den.admin, "/v1/org/auto-router/connect");
    const body = isRecord(connect.body) ? connect.body : {};
    expect(connect.response.ok).toBe(true);
    expect(body.baseURL).toBe(`${world.gatewayUrl}/api/v1`);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
    expect(apiKey.startsWith("ow_gw_")).toBe(true);
    const before = world.upstream.requests.length;
    const response = await fetch(`${world.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-opencode-session-id": "ses_auto_router_proof" },
      body: JSON.stringify({ model: AUTO_ROUTER_MODEL_ID, stream: true, messages: [{ role: "user", content: "What's the capital of France?" }] }),
    });
    const text = await response.text();
    const routedModel = response.headers.get(AUTO_ROUTER_RESPONSE_MODEL_HEADER);
    const reason = response.headers.get(AUTO_ROUTER_RESPONSE_REASON_HEADER);
    expect(response.status).toBe(200);
    expect(routedModel).toBe(ACME_MODEL);
    expect(text).toContain(ACME_REPLY.split(" ")[0]);
    expect(text).toContain("data: [DONE]");
    expect(text).toContain("\"openwork_route\"");
    const upstreamCalls = world.upstream.requests.slice(before);
    expect(upstreamCalls.map((entry) => entry.model)).toEqual([ACME_MODEL]);
    evidence.recordAssertionEvidence(
      "Auto was answered by the configured model as if picked by hand",
      `HTTP ${response.status}; routed=${routedModel}; reason=${reason}; jev configured=${world.jev}; upstream models=${upstreamCalls.map((entry) => entry.model).join(",")}`,
      response.status === 200 && routedModel === ACME_MODEL && upstreamCalls.length === 1,
    );
  });
});

desktopTest("a member picks Auto and sees which model answered their question", async ({ world, user, probe, step, evidence }) => {
  const surface = `[data-session-surface-id="${world.session.sessionId}"]`;
  const autoKey = `${AUTO_ROUTER_PROVIDER_ID}:${AUTO_ROUTER_MODEL_ID}`;
  const autoOption = `model-option-${AUTO_ROUTER_PROVIDER_ID}-${AUTO_ROUTER_MODEL_ID}`;
  const thinking = AUTO_ROUTER_THINKING_LEVELS.find((level) => level === world.thinking);
  const expectedLabel = thinking && thinking !== "default" ? `${world.modelName} · ${AUTO_ROUTER_THINKING_LABELS[thinking]}` : world.modelName;
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  await step("the model picker offers Auto first, above the organization's models", async () => {
    await user.click({ text: "Auto chat" });
    await user.see("composer", { editable: true });
    await user.click("Change model");
    await user.see({ testId: "composer-model-picker" });
    await user.see({ testId: autoOption }, { timeoutMs: 120_000 });
    const [rows, auto] = await Promise.all([
      probe.dom('[data-testid="composer-model-picker"] [data-model-key]'),
      probe.dom(`[data-testid="composer-model-picker"] [data-model-key="${autoKey}"]`),
    ]);
    const first = rows.elements[0];
    // Compare by content: the picker may still be animating between the two reads.
    const autoFirst = Boolean(first && auto.elements[0] && first.text === auto.elements[0].text);
    expect(autoFirst).toBe(true);
    expect(first?.text).toContain("Auto");
    evidence.recordAssertionEvidence("Auto is the first model the member can pick", `picker rows=${rows.elements.length}; first="${first?.text ?? ""}"`, autoFirst);
    await user.screenshot();
  });

  await step("the member chooses Auto and asks a question", async () => {
    await user.click({ testId: autoOption });
    await user.see({ text: "Managed by Auto" });
    await user.press("Escape");
    await user.type("composer", "What's the capital of France?");
    await user.press("Enter");
    await user.see({ text: ACME_REPLY }, { timeoutMs: 120_000 });
    const models = world.upstream.requests.map((entry) => entry.model);
    expect(models).toContain(ACME_MODEL);
    evidence.recordAssertionEvidence("the gateway sent the question to the routed model", `upstream models=${models.join(",")}; jev configured=${world.jev}`, models.includes(ACME_MODEL));
    await user.screenshot();
  });

  await step("after: the reply names the model Auto chose and its thinking level", async () => {
    await user.hover({ text: ACME_REPLY });
    const labels = await probe.eventually(() => probe.dom(`${surface} [data-testid="reply-model"]`), {
      within: 30_000, label: "the answered-by label on the Auto reply",
      until: (value) => value.elements.some((element) => element.text.includes(expectedLabel)),
    });
    await user.see({ testId: "reply-model" });
    const text = labels.elements.map((element) => element.text).join(" | ");
    expect(text).toContain(`Replied with ${expectedLabel}`);
    expect(text).not.toMatch(/ipr_|gwm_|openwork-auto/);
    evidence.recordAssertionEvidence("the Auto reply says which model answered it", `label="${text}"; expected "${expectedLabel}"; opaque ids=0`, text.includes(expectedLabel));
    await user.screenshot();
  });

  await step("reopening the chat keeps the answered-by label", async () => {
    await user.reload();
    await user.see({ text: ACME_REPLY }, { timeoutMs: 60_000 });
    await user.hover({ text: ACME_REPLY });
    const labels = await probe.eventually(() => probe.dom(`${surface} [data-testid="reply-model"]`), {
      within: 30_000, label: "the answered-by label after reload",
      until: (value) => value.elements.some((element) => element.text.includes(expectedLabel)),
    });
    await user.see({ testId: "reply-model" });
    const text = labels.elements.map((element) => element.text).join(" | ");
    evidence.recordAssertionEvidence("the routed model is remembered with the conversation", `label after reload="${text}"`, text.includes(expectedLabel));
    await user.screenshot();
  });
});

missingKeyTest("without the gateway's routing key, Turn on explains how to add it instead of turning Auto on", async ({ world, user, probe, step, evidence }) => {
  await step("before: Turn on is muted and says why", async () => {
    await user.see({ testId: "auto-router-section" }, { timeoutMs: 60_000 });
    await user.see({ testId: "auto-router-missing-key" }, { timeoutMs: 30_000 });
    const settings = await probe.api(world.den.admin, "/v1/org/auto-router");
    expect(isRecord(settings.body) && settings.body.routing).toBe("missing_key");
    const enable = await probe.dom('[data-testid="auto-router-enable"][data-blocked="missing-key"]');
    expect(enable.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Den knows the gateway has no routing key", `routing=${String(isRecord(settings.body) ? settings.body.routing : null)}; Turn on blocked=${enable.elements.length === 1}`, enable.elements.length === 1);
    await user.screenshot();
  });

  await step("after: clicking Turn on opens the setup dialog and nothing is enabled", async () => {
    await user.click({ testId: "auto-router-enable" });
    await user.see({ testId: "auto-router-setup-dialog" }, { timeoutMs: 10_000 });
    await user.see({ text: "Auto Router needs a routing key" });
    await user.see({ text: "TYPESAFE_API_KEY" });
    await user.screenshot();
    const settings = await probe.api(world.den.admin, "/v1/org/auto-router");
    const refused = await world.tryEnable();
    const connect = await probe.api(world.den.admin, "/v1/org/auto-router/connect");
    expect(isRecord(settings.body) && settings.body.enabled).toBe(false);
    expect(refused).toBe(409);
    expect(connect.response.status).toBe(404);
    evidence.recordAssertionEvidence(
      "Auto cannot be turned on or reach desktops without the key",
      `enabled=${String(isRecord(settings.body) ? settings.body.enabled : null)}; enable via API HTTP ${refused}; desktop connect HTTP ${connect.response.status}`,
      refused === 409 && connect.response.status === 404,
    );
    await user.click({ testId: "auto-router-setup-close" });
  });
});
