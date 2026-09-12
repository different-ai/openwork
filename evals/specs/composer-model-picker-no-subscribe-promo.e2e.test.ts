import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { modelPicker, modelPickerEffortWeb } from "../worlds/chat.ts";

const test = spec.world(modelPicker);

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
    expect.objectContaining({ id: world.modelId, providerID: world.providerId, variants: [{ id: "low" }, { id: "high" }, { id: "CustomExact" }, { id: "auto" }] }),
    expect.objectContaining({ id: "standard", providerID: world.providerId, variants: [] }),
  ]) });
  expect(JSON.stringify(catalog.body)).not.toMatch(/synthetic-effort-key|"settings":|"providerOptions":|"headers":/);
  evidence.recordJsonArtifact("MODEL-01 native catalog", catalog);
  await step("Default leaves the closed trigger showing only the model", async () => {
    await user.looks([
      "The closed composer model trigger shows Reasoning witness with a dropdown chevron, without a Default label or a middle-dot separator next to the model name.",
    ]);
    await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness$/ });
  });
  await user.click({ role: "button", label: "Change model" });
  await step("only advertised effort choices are selectable", async () => {
    await user.click({ role: "button", label: /^Effort/ });
    await user.see({ role: "button", label: "Default" });
    await user.see({ role: "button", label: "Low" });
    await user.notSee({ role: "button", label: /^Hidden/ });
    await user.click({ role: "button", label: "High" });
    await user.see({ role: "button", label: "Change model" }, { text: /High/ });
    await user.looks(["The closed composer model trigger shows Reasoning witness followed by a middle-dot separator and High, with a dropdown chevron."]);
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
  await step("returning to Default removes the suffix and persists after reload", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Model\s+Standard witness/ });
    await user.type({ placeholder: "Search models..." }, "Reasoning witness");
    await user.click({ role: "option", label: /^Reasoning witness/ });
    await user.click({ role: "button", label: "High" });
    await user.see({ role: "button", label: "Change model" }, { text: /High/ });
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Effort/ });
    await user.click({ role: "button", label: "Default" });
    await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness$/ });
    await user.reload();
    await user.see("Run task", { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness$/ });
    await user.looks(["The closed composer model trigger shows Reasoning witness and its dropdown chevron, with no Default label and no middle-dot separator next to the model name."]);
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "Default reaches provider after reload", until: (requests) => requests.length === 5 });
    expect((await world.requests())[4]).toMatchObject({ model: world.modelId, reasoningEffort: null });
    await user.see("Run task", { timeoutMs: 30_000 });
    const native = await world.readNative(`${prefix}/session/${world.session.sessionId}`);
    expect(native.body).toMatchObject({ data: { model: { id: world.modelId, providerID: world.providerId, variant: "default" } } });
    evidence.recordJsonArtifact("MODEL-01 Default after reload", native);
    await user.click({ role: "button", label: "Change model" });
    await user.see({ role: "button", label: /^Effort\s+Default/ });
    await user.click({ role: "button", label: /^Effort/ });
    await user.see({ role: "button", label: "Default" });
    await user.looks(["The effort picker is open and retains a selectable Default choice alongside Low, High, Auto, and CustomExact."]);
    await user.click({ role: "button", label: "Auto" });
    await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness\s*· Auto$/ });
    await user.reload();
    await user.see("Run task", { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness\s*· Auto$/ });
    await user.looks(["The closed composer model trigger shows Reasoning witness followed by a middle-dot separator and Auto, with a dropdown chevron."]);
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "explicit Auto reaches provider after reload", until: (requests) => requests.length === 6 });
    expect((await world.requests())[5]).toMatchObject({ model: world.modelId, reasoningEffort: "low" });
    await user.see("Run task", { timeoutMs: 30_000 });
    const explicit = await world.readNative(`${prefix}/session/${world.session.sessionId}`);
    expect(explicit.body).toMatchObject({ data: { model: { id: world.modelId, providerID: world.providerId, variant: "auto" } } });
    evidence.recordJsonArtifact("MODEL-01 explicit auto variant after reload", explicit);
  });
});
