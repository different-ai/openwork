import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { modelPicker, modelPickerEffortWeb } from "../worlds/chat.ts";
import { managedVariantsWeb } from "../worlds/model-managed-variants.ts";

const test = spec.world(modelPicker);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One public model record from the native v2 catalog, with its opaque variant IDs. */
function catalogModel(body: unknown, providerID: string, id: string) {
  const data = isRecord(body) ? body.data : undefined;
  const record = Array.isArray(data)
    ? data.find((entry) => isRecord(entry) && entry.providerID === providerID && entry.id === id)
    : undefined;
  if (!isRecord(record)) throw new Error(`Native catalog is missing ${providerID}/${id}`);
  const variants = Array.isArray(record.variants)
    ? record.variants.flatMap((variant) => isRecord(variant) && typeof variant.id === "string" ? [variant.id] : [])
    : [];
  return { record, variants };
}

test("the composer model pickers keep their controls without the OpenWork Models subscribe promo", async ({ user, probe, step }) => {
  const draft = "Keep this draft while editing model settings.";
  await user.type("composer", draft);
  const initial = await probe.composer();
  await user.click({ role: "button", label: "Change model" });
  await user.click({ role: "button", label: /^Model\s+Big Pickle/ });

  await step("the compact picker keeps controls without subscribe promotion", async () => {
    await user.see({ placeholder: "Search models..." });
    await user.see({ role: "button", label: "All models" });
    await user.see({ role: "button", label: "Connect more providers" });
    for (const removed of [
      "Your API keys",
      "Add your keys",
      "hosted · no API keys",
      "One subscription unlocks these in every workspace.",
      "Enable →",
      "Sign in →",
      "Hide",
    ]) await user.notSee({ text: removed });
  });

  await user.click({ role: "button", label: "All models" });
  await step("the full Models dialog keeps controls without subscribe promotion", async () => {
    await user.see({ text: "Models" });
    await user.see({ text: "Select a model for this session." });
    await user.see({ placeholder: "Search providers and models..." });
    await user.see({ role: "button", label: "Done" });
    await user.notSee({ role: "button", label: "Hide OpenWork Models" });
    await user.notSee({ text: "Subscribe to use hosted frontier models in this workspace." });
    await user.notSee({ text: "Sign in to unlock hosted frontier models for your team." });
    await user.notSee({ role: "button", label: "Subscribe" });
  });
  await step("provider Default is explicit and editing it preserves the draft and model", async () => {
    await user.see({ testId: "current-model-settings" });
    await user.click({ role: "button", label: "Default" });
    expect((await probe.dom('[data-testid="current-model-settings"] button[aria-pressed="true"]')).elements.map((element) => element.text)).toEqual(["Default"]);
    await user.click({ role: "button", label: "Done" });
    await user.see("composer", { text: draft });
    const current = await probe.composer();
    expect(current.selectedModelLabel).toBe(initial.selectedModelLabel);
  });
});

const effortTest = spec.world(modelPickerEffortWeb, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

effortTest("MODEL-01 selected reasoning effort survives reload and reaches the native provider", async ({ world, user, probe, step, evidence }) => {
  expect(world.engine).toBe("v2");
  const runtime = await world.runtimeFacts();
  expect(runtime.browser).toContain("HeadlessChrome");
  expect(runtime.electronBridge).toBe(false);
  evidence.recordJsonArtifact("MODEL-01 headless runtime", runtime);
  const prefix = `/workspace/${world.workspace.workspaceId}/opencode2/api`;
  const status = await world.readNative("/experimental/engine-v2-preview/status");
  expect(status.status).toBe(200);
  expect(status.body).toMatchObject({ running: true, chatRouting: true });
  const catalog = await world.readNative(`${prefix}/model`);
  expect(catalog.status).toBe(200);
  expect(catalog.body).toMatchObject({ data: expect.arrayContaining([
    expect.objectContaining({ id: world.modelId, providerID: world.providerId, variants: [{ id: "low" }, { id: "high" }, { id: "CustomExact" }] }),
    expect.objectContaining({ id: "standard", providerID: world.providerId, variants: [] }),
  ]) });
  expect(JSON.stringify(catalog.body)).not.toMatch(/synthetic-effort-key|"settings":|"providerOptions":|"headers":/);
  evidence.recordJsonArtifact("MODEL-01 native catalog", catalog);
  await user.click({ role: "button", label: "Change model" });
  await step("only advertised effort choices are selectable", async () => {
    await user.click({ role: "button", label: /^Effort/ });
    await user.see({ role: "button", label: "Low" });
    await user.notSee({ role: "button", label: /^Hidden/ });
    await user.click({ role: "button", label: "High" });
    await user.see({ role: "button", label: "Change model" }, { text: /High/ });
  });
  await user.press("Escape");
  await user.type("composer", world.prompt);
  await user.click("Run task");
  await user.see({ text: "Air scatters blue light more strongly." }, { timeoutMs: 90_000 });
  await user.see("Run task", { timeoutMs: 30_000 });
  await step("High is persisted and reaches the real v2 provider request", async () => {
    const requests = await world.requests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: world.modelId, reasoningEffort: "high" });
    expect(await world.modelRequests()).toEqual([{ model: { providerID: world.providerId, id: world.modelId, variant: "high" } }]);
    const native = await world.readNative(`${prefix}/session/${world.session.sessionId}`);
    expect(native.body).toMatchObject({ data: { model: { id: world.modelId, providerID: world.providerId, variant: "high" } } });
    evidence.recordJsonArtifact("MODEL-01 first request and native session", { requests, native });
    await user.reload();
    await user.see("Run task", { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Change model" });
    await user.see({ role: "button", label: /^Effort\s+High/ });
    await user.press("Escape");
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "reloaded effort reaches provider", until: (requests) => requests.length === 2 });
    expect((await world.requests()).map((request) => request.reasoningEffort)).toEqual(["high", "high"]);
    evidence.recordJsonArtifact("MODEL-01 reloaded provider requests", await world.requests());
  });
  await user.see("Run task", { timeoutMs: 30_000 });
  await step("a custom effort ID reaches native resolution without case changes", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Effort/ });
    await user.click({ role: "button", label: "CustomExact" });
    await user.see({ role: "button", label: "Change model" }, { text: /CustomExact/ });
    await user.press("Escape");
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "custom effort reaches provider", until: (requests) => requests.length === 3 });
    expect((await world.requests()).map((request) => request.reasoningEffort)).toEqual(["high", "high", "low"]);
    const native = await world.readNative(`${prefix}/session/${world.session.sessionId}`);
    expect(native.body).toMatchObject({ data: { model: { id: world.modelId, providerID: world.providerId, variant: "CustomExact" } } });
    evidence.recordJsonArtifact("MODEL-01 custom effort request and native session", { requests: await world.requests(), native });
  });
  await user.see("Run task", { timeoutMs: 30_000 });
  await step("a model without advertised variants keeps effort unavailable", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Model\s+Reasoning witness/ });
    await user.type({ placeholder: "Search models..." }, "Standard witness");
    await user.click({ role: "option", label: /^Standard witness/ });
    await user.see({ role: "button", label: "Change model" }, { text: /Standard witness/ });
    await user.notSee({ placeholder: "Search models..." });
    await user.click({ role: "button", label: "Change model" });
    await user.see({ role: "button", label: /^Effort\s+Unavailable/ });
    const disabled = await probe.dom('[data-slot="model-select-root"] button:disabled');
    expect(disabled.elements.some((button) => button.text.includes("Effort") && button.text.includes("Unavailable"))).toBe(true);
    await user.press("Escape");
    await probe.eventually(() => probe.dom('[data-slot="model-select-root"]'), {
      within: 5_000, label: "effort picker finishes closing", until: (snapshot) => snapshot.elements.length === 0,
    });
    await user.notSee({ role: "button", label: /^Effort\s+Unavailable/ });
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "unsupported model omits effort", until: (requests) => requests.length === 4 });
    const requests = await world.requests();
    expect(requests[3]).toMatchObject({ model: "standard", reasoningEffort: null });
    const native = await world.readNative(`${prefix}/session/${world.session.sessionId}`);
    const modelRequests = await world.modelRequests();
    expect(modelRequests).toEqual([
      { model: { providerID: world.providerId, id: world.modelId, variant: "high" } },
      { model: { providerID: world.providerId, id: world.modelId, variant: "CustomExact" } },
      { model: { providerID: world.providerId, id: "standard" } },
    ]);
    // Native v2 canonicalizes an omitted variant to its internal default ID.
    expect(native.body).toMatchObject({ data: { model: { id: "standard", providerID: world.providerId, variant: "default" } } });
    evidence.recordJsonArtifact("MODEL-01 unsupported model request and native session", { requests, modelRequests, native });
    await user.see("Run task", { timeoutMs: 30_000 });
  });
});

const managedTest = spec.world(managedVariantsWeb, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

managedTest("MODEL-02 managed catalog providers derive reasoning effort from the native engine catalog", async ({ world, user, probe, step, evidence }) => {
  expect(world.engine).toBe("v2");
  const runtime = await world.runtimeFacts();
  expect(runtime.browser).toContain("HeadlessChrome");
  expect(runtime.electronBridge).toBe(false);
  evidence.recordJsonArtifact("MODEL-02 headless runtime", runtime);
  const prefix = `/workspace/${world.workspace.workspaceId}/opencode2/api`;
  const status = await world.readNative("/experimental/engine-v2-preview/status");
  expect(status.status).toBe(200);
  expect(status.body).toMatchObject({ running: true, chatRouting: true, mirroredProviderIds: expect.arrayContaining([world.providerId, world.pinnedProviderId]) });
  const catalog = await world.readNative(`${prefix}/model`);
  expect(catalog.status).toBe(200);
  await step("the engine catalog supplies effort choices only where Den left them to the catalog", async () => {
    const reasoning = catalogModel(catalog.body, world.providerId, world.modelId);
    const standard = catalogModel(catalog.body, world.providerId, world.standardModelId);
    const pinned = catalogModel(catalog.body, world.pinnedProviderId, world.pinnedModelId);
    // Den sent no variants: the engine copied its catalog list (models.dev
    // reasoning_options) onto the wire model. Exact membership belongs to the
    // live catalog; the contract is a non-empty, duplicate-free list that
    // carries the standard efforts and none of the Den-pinned custom IDs.
    expect(reasoning.variants.length).toBeGreaterThanOrEqual(2);
    expect(new Set(reasoning.variants).size).toBe(reasoning.variants.length);
    expect(reasoning.variants).toEqual(expect.arrayContaining(["low", "high"]));
    expect(reasoning.variants).not.toEqual(expect.arrayContaining(["CustomExact"]));
    expect(reasoning.variants).not.toEqual(expect.arrayContaining(["hidden"]));
    expect(reasoning.record).toMatchObject({ canonical: "openai", providerID: world.providerId });
    // Same provider, no catalog reasoning options: nothing is invented.
    expect(standard.variants).toEqual([]);
    expect(standard.record).toMatchObject({ canonical: "openai" });
    // Explicit Den variants win: exactly the enabled entries, no catalog set.
    expect(pinned.variants).toEqual(["low", "CustomExact"]);
    expect(pinned.record).not.toHaveProperty("canonical");
    // The public catalog exposes opaque IDs only; keys and settings stay inside the engine.
    expect(JSON.stringify(catalog.body)).not.toMatch(/managed-den-resolved-key|managed-den-pinned-key|"settings":|"providerOptions":|"headers":|reasoningEffort|reasoningSummary/);
    evidence.recordJsonArtifact("MODEL-02 native catalog", { reasoning, standard, pinned, status: status.body });
  });
  await user.click({ role: "button", label: "Change model" });
  await step("the composer offers the catalog efforts and none of another provider's pinned IDs", async () => {
    await user.click({ role: "button", label: /^Effort/ });
    await user.see({ role: "button", label: "Low" });
    await user.see({ role: "button", label: "High" });
    await user.notSee({ role: "button", label: "CustomExact" });
    await user.notSee({ role: "button", label: /^Hidden/ });
    await user.click({ role: "button", label: "High" });
    await user.see({ role: "button", label: "Change model" }, { text: /High/ });
  });
  await user.press("Escape");
  await user.type("composer", world.prompt);
  await user.click("Run task");
  await user.see({ text: "Air scatters blue light more strongly." }, { timeoutMs: 90_000 });
  await user.see("Run task", { timeoutMs: 30_000 });
  await step("High reaches the managed provider with the Den-resolved key and survives reload", async () => {
    const requests = await world.requests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: world.modelId, reasoningEffort: "high", authorization: `Bearer ${world.apiKey}` });
    expect(await world.modelRequests()).toEqual([{ model: { providerID: world.providerId, id: world.modelId, variant: "high" } }]);
    const native = await world.readNative(`${prefix}/session/${world.session.sessionId}`);
    expect(native.body).toMatchObject({ data: { model: { id: world.modelId, providerID: world.providerId, variant: "high" } } });
    evidence.recordJsonArtifact("MODEL-02 first request and native session", { requests, native });
    await user.reload();
    await user.see("Run task", { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Change model" });
    await user.see({ role: "button", label: /^Effort\s+High/ });
    await user.press("Escape");
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "reloaded effort reaches managed provider", until: (requests) => requests.length === 2 });
    expect((await world.requests()).map((request) => request.reasoningEffort)).toEqual(["high", "high"]);
    evidence.recordJsonArtifact("MODEL-02 reloaded provider requests", await world.requests());
  });
  await user.see("Run task", { timeoutMs: 30_000 });
  await step("Low reaches the managed provider as low", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Effort/ });
    await user.click({ role: "button", label: "Low" });
    await user.see({ role: "button", label: "Change model" }, { text: /Low/ });
    await user.press("Escape");
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "low effort reaches managed provider", until: (requests) => requests.length === 3 });
    expect((await world.requests()).map((request) => request.reasoningEffort)).toEqual(["high", "high", "low"]);
    const native = await world.readNative(`${prefix}/session/${world.session.sessionId}`);
    expect(native.body).toMatchObject({ data: { model: { id: world.modelId, providerID: world.providerId, variant: "low" } } });
    evidence.recordJsonArtifact("MODEL-02 low effort request and native session", { requests: await world.requests(), native });
  });
  await user.see("Run task", { timeoutMs: 30_000 });
  await step("a managed model without catalog reasoning options keeps effort unavailable", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Model\s+GPT-5\.4 witness/ });
    await user.type({ placeholder: "Search models..." }, "GPT-4.1 witness");
    await user.click({ role: "option", label: /^GPT-4\.1 witness/ });
    await user.see({ role: "button", label: "Change model" }, { text: /GPT-4\.1 witness/ });
    await user.notSee({ placeholder: "Search models..." });
    await user.click({ role: "button", label: "Change model" });
    await user.see({ role: "button", label: /^Effort\s+Unavailable/ });
    const disabled = await probe.dom('[data-slot="model-select-root"] button:disabled');
    expect(disabled.elements.some((button) => button.text.includes("Effort") && button.text.includes("Unavailable"))).toBe(true);
    await user.press("Escape");
    await probe.eventually(() => probe.dom('[data-slot="model-select-root"]'), {
      within: 5_000, label: "effort picker finishes closing", until: (snapshot) => snapshot.elements.length === 0,
    });
    await user.notSee({ role: "button", label: /^Effort\s+Unavailable/ });
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "standard managed model omits effort", until: (requests) => requests.length === 4 });
    const requests = await world.requests();
    expect(requests[3]).toMatchObject({ model: world.standardModelId, reasoningEffort: null, authorization: `Bearer ${world.apiKey}` });
    const native = await world.readNative(`${prefix}/session/${world.session.sessionId}`);
    const modelRequests = await world.modelRequests();
    expect(modelRequests).toEqual([
      { model: { providerID: world.providerId, id: world.modelId, variant: "high" } },
      { model: { providerID: world.providerId, id: world.modelId, variant: "low" } },
      { model: { providerID: world.providerId, id: world.standardModelId } },
    ]);
    // Native v2 canonicalizes an omitted variant to its internal default ID.
    expect(native.body).toMatchObject({ data: { model: { id: world.standardModelId, providerID: world.providerId, variant: "default" } } });
    evidence.recordJsonArtifact("MODEL-02 standard model request and native session", { requests, modelRequests, native });
    await user.see("Run task", { timeoutMs: 30_000 });
  });
  await step("a Den-pinned model offers exactly its own efforts in the composer", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Model\s+GPT-4\.1 witness/ });
    await user.type({ placeholder: "Search models..." }, "GPT-5.1 pinned");
    await user.click({ role: "option", label: /^GPT-5\.1 pinned/ });
    // Choosing a model that has effort choices continues into its effort pane.
    await user.see({ role: "button", label: "Low" });
    await user.see({ role: "button", label: "CustomExact" });
    await user.notSee({ role: "button", label: "Medium" });
    await user.notSee({ role: "button", label: "High" });
    await user.notSee({ role: "button", label: /^Hidden/ });
    await user.click({ role: "button", label: "CustomExact" });
    await user.see({ role: "button", label: "Change model" }, { text: /GPT-5\.1 pinned/ });
    await user.see({ role: "button", label: "Change model" }, { text: /CustomExact/ });
    await user.notSee({ placeholder: "Search models..." });
  });
  await step("every managed provider request carried only its own Den-resolved credential", async () => {
    const requests = await world.requests();
    expect(requests).toHaveLength(4);
    expect(requests.map((request) => request.authorization)).toEqual(Array(4).fill(`Bearer ${world.apiKey}`));
    expect(requests.some((request) => request.authorization?.includes(world.pinnedApiKey))).toBe(false);
    evidence.recordJsonArtifact("MODEL-02 provider credential witness", requests.map((request) => ({ model: request.model, reasoningEffort: request.reasoningEffort, authorization: request.authorization })));
  });
});
