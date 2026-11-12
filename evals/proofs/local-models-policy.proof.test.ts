import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { record } from "../worlds/org-invite.ts";
import { localModelsPolicy } from "../worlds/local-models-policy.ts";

const test = spec.world(localModelsPolicy, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb", "web"], services: ["den"] },
});
const WITHIN = 60_000;

test("the owner turns off local models for Acme while keeping personal keys; an admin sees it locked; a member's Ollama is locked on their desktop", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.ownerWeb);
  const admin = user.on(world.adminWeb);
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  await step("before: Riley can set up Ollama on their desktop", async () => {
    await user.navigate(world.ollamaUrl);
    await user.see({ text: "Configuration" }, { timeoutMs: WITHIN });
    await user.notSee({ testId: "local-models-blocked" });
    const stored = await world.stored();
    evidence.recordAssertionEvidence("Nothing is restricted yet", `stored allowCustomProviders=${String(stored.allowCustomProviders)}, allowLocalModels=${String(stored.allowLocalModels)}; Ollama page not locked`, stored.allowLocalModels !== false);
    await user.screenshot();
  });

  await step("an admin sees who can use models, locked, with why", async () => {
    await admin.see({ testId: "gateway-model-policy-row" }, { timeoutMs: WITHIN });
    await admin.see({ testId: "gateway-model-policy-locked" });
    await admin.see({ text: /Manage desktop policies/ });
    await admin.notSee({ testId: "gateway-model-policy-open" });
    const change = (await probe.on(world.adminWeb).dom('[data-testid="gateway-model-policy-open"]')).elements.length;
    const lock = (await probe.on(world.adminWeb).dom('[data-testid="gateway-model-policy-locked"]')).elements.length;
    expect([change, lock]).toEqual([0, 1]);
    evidence.recordAssertionEvidence("An admin without Manage desktop policies gets a lock and the reason, not a Save that fails", `Change buttons=${change}; locks=${lock}; reason names the permission`, change === 0 && lock === 1);
    await admin.screenshot();
  });

  await step("the owner turns off local models and keeps personal keys", async () => {
    await owner.see({ testId: "gateway-model-policy-open" }, { timeoutMs: WITHIN });
    await owner.click({ testId: "gateway-model-policy-open" });
    await owner.see({ testId: "gateway-model-access-local" });
    await owner.click({ role: "switch", label: "Local models" });
    await owner.screenshot();
    await owner.click({ testId: "gateway-model-policy-save" });
    await probe.on(world.ownerWeb).eventually(() => probe.on(world.ownerWeb).dom('[data-testid="gateway-model-access-local"]'), {
      within: WITHIN, label: "the dialog closes after saving", until: (dom) => dom.elements.length === 0,
    });
    await owner.see({ text: /Local models off/ }, { timeoutMs: WITHIN });
    const stored = await world.stored();
    expect(stored).toEqual({ allowCustomProviders: true, allowLocalModels: false });
    evidence.recordAssertionEvidence("Den stores local models off, personal keys still on", `allowCustomProviders=${String(stored.allowCustomProviders)}; allowLocalModels=${String(stored.allowLocalModels)}`, stored.allowLocalModels === false && stored.allowCustomProviders === true);
    await owner.screenshot();
  });

  await step("after: Riley's Ollama page is locked and names who turned it off; their desktop refuses adding Ollama", async () => {
    await world.refreshServerPolicy();
    await user.reload();
    await user.see({ testId: "local-models-blocked" }, { timeoutMs: WITHIN });
    await user.see({ text: "Acme turned off Ollama and LM Studio." });
    const refused = await world.addOllama();
    const code = record(refused.body).code;
    expect(refused.status).toBe(403);
    expect(code).toBe("organization_local_models_denied");
    evidence.recordAssertionEvidence("The local server refuses writing an Ollama provider", `PATCH workspace config with ollama -> HTTP ${refused.status} ${String(code)}`, refused.status === 403);
    await user.screenshot();
  });

  await step("Riley's app permissions show local models blocked and personal keys still allowed", async () => {
    await user.navigate(world.accountUrl);
    await user.click({ role: "tab", label: "App permissions" }, { timeoutMs: WITHIN });
    const rowText = async (key: string) => (await probe.dom(`[data-testid="app-permission-${key}"]`)).elements[0]?.text ?? "";
    const blocked = await probe.eventually(() => rowText("allowLocalModels"), { within: WITHIN, label: "local models row", until: (value) => value.includes("Blocked") });
    const keys = await rowText("allowCustomProviders");
    expect(keys).toContain("Allowed");
    evidence.recordAssertionEvidence("Each switch reads on its own", `Use local models: ${blocked.includes("Blocked") ? "Blocked" : blocked}; Add AI providers: ${keys.includes("Allowed") ? "Allowed" : keys}`, keys.includes("Allowed"));
    await user.screenshot();
  });

  await step("turning local models back on unlocks Riley's Ollama page", async () => {
    await owner.click({ testId: "gateway-model-policy-open" });
    await owner.click({ role: "switch", label: "Local models" });
    await owner.click({ testId: "gateway-model-policy-save" });
    await owner.see({ text: /Local models on/ }, { timeoutMs: WITHIN });
    await world.refreshServerPolicy();
    // Members pick up the change the next time OpenWork opens.
    await user.navigate(world.ollamaUrl);
    await probe.eventually(() => probe.dom('[data-testid="local-models-blocked"]'), {
      within: WITHIN, label: "the Ollama page unlocks", until: (dom) => dom.elements.length === 0,
    });
    await user.see({ text: "Configuration" });
    const allowed = await world.addOllama();
    expect(allowed.status).toBeLessThan(300);
    evidence.recordAssertionEvidence("Reversible: the page unlocks and the server accepts Ollama again", `PATCH workspace config with ollama -> HTTP ${allowed.status}`, allowed.status < 300);
    await user.screenshot();
  });
});
