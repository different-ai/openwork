import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  AUTO_ROUTER_MODEL_ID,
  AUTO_ROUTER_PROVIDER_ID,
  AUTO_ROUTER_RESPONSE_MODEL_HEADER,
  AUTO_ROUTER_RESPONSE_REASON_HEADER,
  AUTO_ROUTER_THINKING_LABELS,
  AUTO_ROUTER_THINKING_LEVELS,
} from "@openwork/types/den/auto-router";
import { ACME_MODEL, ACME_REPLY } from "../../worlds/lib/acme-gateway.ts";
import { autoRouterDesktopWorld, autoRouterWorld } from "../worlds/auto-router.ts";
import { isRecord } from "./../worlds/library.ts";

const test = spec.world(autoRouterWorld, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });
const desktopTest = spec.world(autoRouterDesktopWorld, {
  resources: { surfaces: ["appWeb"], services: ["den"] },
  // The shipping server downloads its pinned verified v2 engine if absent.
  needs: { commands: ["bun"] }, timeout: 900_000,
});

test("an admin enables the Auto Router and Auto answers through the chosen Gateway model", async ({ world, user, probe, step, evidence }) => {
  await step("before: the AI Providers tab offers the Auto Router above Providers", async () => {
    await user.see({ testId: "auto-router-section" }, { timeoutMs: 60_000 });
    await user.see({ text: "Auto Router" });
    await user.see({ testId: "auto-router-enable" });
    const connect = await probe.api(world.den.admin, "/v1/org/auto-router/connect");
    expect(connect.response.status).toBe(404);
    evidence.recordAssertionEvidence("desktops get no Auto before it is configured", `connect HTTP ${connect.response.status}`, connect.response.status === 404);
    await user.screenshot();
  });

  await step("an admin enables it and saves a route with two thinking levels", async () => {
    await user.click({ testId: "auto-router-enable" });
    await user.see({ testId: "auto-router-editor" }, { timeoutMs: 30_000 });
    await user.see({ role: "combobox", label: "Model" }, { value: world.provider.modelName.replace(/ \(.*\)$/, ""), timeoutMs: 30_000 });
    const levels = await probe.dom('[data-testid^="auto-router-thinking-"]');
    const offered = levels.elements.map((entry) => entry.text);
    if (offered.includes("High")) await user.click({ testId: "auto-router-thinking-high" });
    await user.type({ testId: "auto-router-prompt" }, "Everyday questions, small edits and short answers");
    await user.screenshot();
    await user.click({ testId: "auto-router-save-route" });
    await user.see({ testId: "auto-router-route" }, { timeoutMs: 30_000 });
    const saved = await probe.api(world.den.admin, "/v1/org/auto-router");
    const routes = isRecord(saved.body) && Array.isArray(saved.body.routes) ? saved.body.routes.filter(isRecord) : [];
    expect(saved.response.ok).toBe(true);
    expect(isRecord(saved.body) && saved.body.enabled).toBe(true);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.modelId).toBe(ACME_MODEL);
    expect(routes[0]?.prompt).toBe("Everyday questions, small edits and short answers");
    const thinking = Array.isArray(routes[0]?.thinkingLevels) ? routes[0].thinkingLevels : [];
    expect(thinking).toContain("default");
    evidence.recordAssertionEvidence("the route is stored with its prompt, model and thinking levels", `offered=${offered.join("/")}; stored model=${String(routes[0]?.modelId)} levels=${thinking.join(",")}`, routes.length === 1 && routes[0]?.modelId === ACME_MODEL);
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
    const autoFirst = Boolean(first && auto.elements[0] && first.rect.top === auto.elements[0].rect.top && first.text === auto.elements[0].text);
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
