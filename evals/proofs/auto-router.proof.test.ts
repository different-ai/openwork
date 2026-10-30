import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  AUTO_ROUTER_PROVIDER_ID,
  AUTO_ROUTER_RESPONSE_MODEL_HEADER,
  AUTO_ROUTER_RESPONSE_REASON_HEADER,
  autoRouterModelId,
  autoRouterModelName,
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

function routersOf(body: unknown) {
  return isRecord(body) && Array.isArray(body.routers) ? body.routers.filter(isRecord) : [];
}

test("an admin adds a Smart Router in two steps from AI Providers and its Smart model answers through it", async ({ world, user, probe, step, evidence }) => {
  const modelLabel = world.provider.modelName.replace(/ \(.*\)$/, "");
  let routerId = "";

  await step("before: AI Providers offers Add a Smart Router beside Add a provider, and no router is listed", async () => {
    await user.see({ testId: "ai-gateway-panel-ai-providers" }, { timeoutMs: 60_000 });
    await user.see({ testId: "gateway-provider-row" }, { timeoutMs: 60_000 });
    await user.see({ testId: "auto-router-new" }, { text: "Add a Smart Router", timeoutMs: 30_000 });
    await user.see({ testId: "gateway-provider-create" }, { text: "Add a provider" });
    const tabs = await probe.dom('[data-testid="ai-gateway-tabs"] [role="tab"]');
    const tabNames = tabs.elements.map((entry) => entry.text);
    expect(tabNames).not.toContain("Smart Model Router");
    const rows = await probe.dom('[data-testid="auto-router-row"]');
    expect(rows.elements).toHaveLength(0);
    const connect = await probe.api(world.den.admin, "/v1/org/auto-router/connect");
    expect(connect.response.status).toBe(404);
    evidence.recordAssertionEvidence("no Smart Router tab, no routers, nothing for desktops", `tabs=${tabNames.join("/")}; rows=0; connect HTTP ${connect.response.status}`, connect.response.status === 404);
    await user.screenshot();
  });

  await step("step 1: the admin names the router and gives a model two tasks", async () => {
    await user.click({ testId: "auto-router-new" });
    await user.see({ testId: "auto-router-steps" }, { timeoutMs: 30_000 });
    await user.type({ testId: "auto-router-name" }, "Engineering");
    await user.click({ role: "combobox", label: "Model 1" });
    const option = { role: "option", label: new RegExp(modelLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) } as const;
    await user.see(option, { timeoutMs: 30_000 });
    await user.click(option);
    const tasks = { role: "combobox", label: `Tasks for ${modelLabel}` } as const;
    await user.type(tasks, "Debugging");
    await user.press("Enter");
    await user.see({ role: "button", label: "Remove Debugging" });
    // Typed but not added with Enter: saved as a task too.
    await user.type(tasks, "Code review");
    await user.screenshot();
    await user.click({ testId: "auto-router-save" });
    await user.see({ testId: "auto-router-access" }, { timeoutMs: 30_000 });
  });

  await step("after step 1: the router exists with its tasks but applies to nobody yet", async () => {
    const saved = await probe.api(world.den.admin, "/v1/org/auto-routers");
    const router = routersOf(saved.body)[0];
    const assignment = isRecord(router?.assignment) ? router.assignment : {};
    const models = Array.isArray(router?.models) ? router.models.filter(isRecord) : [];
    const tasks = Array.isArray(models[0]?.tasks) ? models[0].tasks : [];
    routerId = typeof router?.id === "string" ? router.id : "";
    const connect = await probe.api(world.den.admin, "/v1/org/auto-router/connect");
    expect(router?.name).toBe("Engineering");
    expect(tasks).toEqual(["Debugging", "Code review"]);
    expect(assignment).toEqual({ everyone: false, teamIds: [], memberIds: [] });
    expect(connect.response.status).toBe(404);
    evidence.recordAssertionEvidence(
      "step 1 creates the router with no one assigned",
      `name=${String(router?.name)}; tasks=${tasks.join("/")}; everyone=${String(assignment.everyone)}; connect HTTP ${connect.response.status}`,
      routerId !== "" && assignment.everyone === false && connect.response.status === 404,
    );
    await user.screenshot();
  });

  await step("step 2: the admin makes it apply to everyone, and it is listed first under AI Providers", async () => {
    await user.click({ testId: "access-everyone" });
    await user.click({ testId: "auto-router-save-access" });
    await user.see({ testId: "auto-router-row" }, { timeoutMs: 30_000 });
    const rows = await probe.dom('[data-testid="gateway-provider-row"], [data-testid="auto-router-row"]');
    const first = rows.elements[0]?.text ?? "";
    expect(first).toContain("Smart: Engineering");
    const saved = await probe.api(world.den.admin, "/v1/org/auto-routers");
    const router = routersOf(saved.body)[0];
    const assignment = isRecord(router?.assignment) ? router.assignment : {};
    expect(assignment.everyone).toBe(true);
    evidence.recordAssertionEvidence("the Smart Router is the first row, like a provider, and applies to everyone", `first row="${first.replace(/\s+/g, " ")}"; everyone=${String(assignment.everyone)}`, first.includes("Smart: Engineering"));
    await user.screenshot();
  });

  await step("after: the Smart model routes a chat request to the router's model through the Gateway", async () => {
    const connect = await probe.api(world.den.admin, "/v1/org/auto-router/connect");
    const body = isRecord(connect.body) ? connect.body : {};
    const offered = Array.isArray(body.models) ? body.models.filter(isRecord) : [];
    expect(connect.response.ok).toBe(true);
    expect(body.baseURL).toBe(`${world.gatewayUrl}/api/v1`);
    expect(offered).toEqual([{ id: autoRouterModelId(routerId), name: autoRouterModelName("Engineering") }]);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
    expect(apiKey.startsWith("ow_gw_")).toBe(true);
    const before = world.upstream.requests.length;
    const response = await fetch(`${world.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-opencode-session-id": "ses_smart_router_proof" },
      body: JSON.stringify({ model: autoRouterModelId(routerId), stream: true, messages: [{ role: "user", content: "Why does this test crash?" }] }),
    });
    const text = await response.text();
    const routedModel = response.headers.get(AUTO_ROUTER_RESPONSE_MODEL_HEADER);
    const reason = response.headers.get(AUTO_ROUTER_RESPONSE_REASON_HEADER);
    expect(response.status).toBe(200);
    expect(routedModel).toBe(ACME_MODEL);
    expect(text).toContain(ACME_REPLY.split(" ")[0]);
    expect(text).toContain("data: [DONE]");
    const upstreamCalls = world.upstream.requests.slice(before);
    expect(upstreamCalls.map((entry) => entry.model)).toEqual([ACME_MODEL]);
    evidence.recordAssertionEvidence(
      "the Smart model was answered by the router's model as if picked by hand",
      `HTTP ${response.status}; routed=${routedModel}; reason=${reason}; jev configured=${world.jev}; upstream models=${upstreamCalls.map((entry) => entry.model).join(",")}`,
      response.status === 200 && routedModel === ACME_MODEL && upstreamCalls.length === 1,
    );
  });

  await step("after: removing the router from its page removes its Smart model and its now unused tasks", async () => {
    await user.click({ testId: "auto-router-open" });
    await user.see({ testId: "auto-router-delete" }, { timeoutMs: 30_000 });
    await user.click({ testId: "auto-router-delete" });
    await user.see({ testId: "confirm-dialog" });
    await user.click({ testId: "confirm-dialog-action" });
    await user.see({ testId: "gateway-provider-row" }, { timeoutMs: 30_000 });
    const after = await probe.eventually(() => probe.api(world.den.admin, "/v1/org/auto-routers"), {
      within: 30_000, label: "the router is gone", until: (value) => routersOf(value.body).length === 0,
    });
    const tasks = isRecord(after.body) && Array.isArray(after.body.tasks) ? after.body.tasks : [];
    const connect = await probe.api(world.den.admin, "/v1/org/auto-router/connect");
    expect(tasks).toEqual([]);
    expect(connect.response.status).toBe(404);
    evidence.recordAssertionEvidence("unused tasks are removed with the router", `tasks=${tasks.length}; connect HTTP ${connect.response.status}`, tasks.length === 0);
    await user.screenshot();
  });
});

desktopTest("a member picks a Smart model and sees which model answered their question", async ({ world, user, probe, step, evidence }) => {
  const surface = `[data-session-surface-id="${world.session.sessionId}"]`;
  const modelId = autoRouterModelId(world.routerId);
  const smartKey = `${AUTO_ROUTER_PROVIDER_ID}:${modelId}`;
  const smartOption = `model-option-${AUTO_ROUTER_PROVIDER_ID}-${modelId}`;
  const smartName = autoRouterModelName(world.routerName);
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  await step("the model picker offers Smart: Engineering first, above the organization's models", async () => {
    await user.click({ text: "Smart chat" });
    await user.see("composer", { editable: true });
    await user.click("Change model");
    await user.see({ testId: "composer-model-picker" });
    await user.see({ testId: smartOption }, { timeoutMs: 120_000 });
    const [rows, smart] = await Promise.all([
      probe.dom('[data-testid="composer-model-picker"] [data-model-key]'),
      probe.dom(`[data-testid="composer-model-picker"] [data-model-key="${smartKey}"]`),
    ]);
    const first = rows.elements[0];
    // Compare by content: the picker may still be animating between the two reads.
    const smartFirst = Boolean(first && smart.elements[0] && first.text === smart.elements[0].text);
    expect(smartFirst).toBe(true);
    expect(first?.text).toContain(smartName);
    evidence.recordAssertionEvidence("the Smart model is the first model the member can pick", `picker rows=${rows.elements.length}; first="${first?.text ?? ""}"`, smartFirst);
    await user.screenshot();
  });

  await step("the member chooses it and asks a question", async () => {
    await user.click({ testId: smartOption });
    await user.see({ text: "Managed by Smart Router" });
    await user.press("Escape");
    await user.type("composer", "What's the capital of France?");
    await user.press("Enter");
    await user.see({ text: ACME_REPLY }, { timeoutMs: 120_000 });
    const models = world.upstream.requests.map((entry) => entry.model);
    expect(models).toContain(ACME_MODEL);
    evidence.recordAssertionEvidence("the gateway sent the question to the routed model", `upstream models=${models.join(",")}; jev configured=${world.jev}`, models.includes(ACME_MODEL));
    await user.screenshot();
  });

  await step("after: the reply names the model Smart chose", async () => {
    await user.hover({ text: ACME_REPLY });
    const labels = await probe.eventually(() => probe.dom(`${surface} [data-testid="reply-model"]`), {
      within: 30_000, label: "the answered-by label on the Smart reply",
      until: (value) => value.elements.some((element) => element.text.includes(world.modelName)),
    });
    await user.see({ testId: "reply-model" });
    const text = labels.elements.map((element) => element.text).join(" | ");
    expect(text).toContain(`Replied with ${world.modelName}`);
    expect(text).not.toMatch(/ipr_|gwm_|openwork-auto|openwork-smart/);
    evidence.recordAssertionEvidence("the Smart reply says which model answered it", `label="${text}"; expected "${world.modelName}"; opaque ids=0`, text.includes(world.modelName));
    await user.screenshot();
  });

  await step("reopening the chat keeps the answered-by label", async () => {
    await user.reload();
    await user.see({ text: ACME_REPLY }, { timeoutMs: 60_000 });
    await user.hover({ text: ACME_REPLY });
    const labels = await probe.eventually(() => probe.dom(`${surface} [data-testid="reply-model"]`), {
      within: 30_000, label: "the answered-by label after reload",
      until: (value) => value.elements.some((element) => element.text.includes(world.modelName)),
    });
    await user.see({ testId: "reply-model" });
    const text = labels.elements.map((element) => element.text).join(" | ");
    evidence.recordAssertionEvidence("the routed model is remembered with the conversation", `label after reload="${text}"`, text.includes(world.modelName));
    await user.screenshot();
  });
});

missingKeyTest("without the gateway's routing key, Add a Smart Router explains how to add it instead of creating one", async ({ world, user, probe, step, evidence }) => {
  await step("before: Add a Smart Router is muted and says why", async () => {
    await user.see({ testId: "ai-gateway-panel-ai-providers" }, { timeoutMs: 60_000 });
    await user.see({ testId: "auto-router-new" }, { timeoutMs: 60_000 });
    const list = await probe.api(world.den.admin, "/v1/org/auto-routers");
    expect(isRecord(list.body) && list.body.routing).toBe("missing_key");
    const create = await probe.dom('[data-testid="auto-router-new"][data-blocked="missing-key"]');
    expect(create.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Den knows the gateway has no routing key", `routing=${String(isRecord(list.body) ? list.body.routing : null)}; New blocked=${create.elements.length === 1}`, create.elements.length === 1);
    await user.screenshot();
  });

  await step("after: clicking Add a Smart Router opens the setup dialog and nothing is created", async () => {
    await user.click({ testId: "auto-router-new" });
    await user.see({ testId: "auto-router-setup-dialog" }, { timeoutMs: 10_000 });
    await user.see({ text: "Smart Model Router needs a routing key" });
    await user.see({ text: "TYPESAFE_API_KEY" });
    await user.screenshot();
    const refused = await world.tryCreate();
    const list = await probe.api(world.den.admin, "/v1/org/auto-routers");
    const connect = await probe.api(world.den.admin, "/v1/org/auto-router/connect");
    expect(refused).toBe(409);
    expect(routersOf(list.body)).toHaveLength(0);
    expect(connect.response.status).toBe(404);
    evidence.recordAssertionEvidence(
      "Smart Routers cannot be created or reach desktops without the key",
      `create via API HTTP ${refused}; routers=${routersOf(list.body).length}; desktop connect HTTP ${connect.response.status}`,
      refused === 409 && connect.response.status === 404,
    );
    await user.click({ testId: "auto-router-setup-close" });
  });
});
