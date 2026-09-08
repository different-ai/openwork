import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { modelPicker } from "../worlds/chat.ts";

const test = spec.world(modelPicker, { timeout: 360_000 });

test("managed model discovery keeps the task unchanged until an explicit eligible selection", async ({ world, user, probe, step }) => {
  const draft = "Keep this model-picker draft. Do not send it.";
  const contains = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const row = (modelID: string, providerID = "openwork") => ({ testId: `model-option-${providerID}-${modelID}` });
  const luna = row(world.luna.modelID);
  const astra = row(world.astra.modelID);
  const own = row("big-pickle", "opencode");
  const search = { label: "Search all models" };
  const messagesPath = `/workspace/${world.workspace.workspaceId}/opencode/session/${world.session.sessionId}/message`;
  const browserBefore = await world.browserDestinations();
  await user.type("composer", draft);
  const initial = await probe.composer();
  expect(initial.selectedModelLabel).toContain("Big Pickle");
  expect(initial.userMessageCount).toBe(0);
  expect(initial.assistantMessageCount).toBe(0);
  const unchanged = async (selectedModelLabel: string) => {
    expect(await probe.composer()).toMatchObject({
      draftText: draft, route: initial.route, selectedModelLabel,
      userMessageCount: 0, assistantMessageCount: 0, modelUnavailable: false,
    });
    const messages = await probe.desktopApi(messagesPath);
    expect(messages.status).toBe(200);
    expect(messages.body).toEqual([]);
    const requests = await world.proxy.requestLog();
    expect(requests.filter((request) => request.method === "POST"
      && /checkout|billing|llm-providers|model-picker-fixture\/inference|chat\/completions|responses/.test(request.path))).toEqual([]);
    expect(await world.browserDestinations()).toEqual(browserBefore);
  };

  await step("real Den enrollment supplies free access and recommendations without unsolicited promotion", async () => {
    const access = await probe.api(world.member, world.accessPath);
    expect(access.response.status).toBe(200);
    expect(access.body).toEqual(world.freeResponse);
    expect(world.configuredModels).toEqual(expect.arrayContaining(world.catalog.map((model) => model.modelID)));
    const requests = await world.proxy.requestLog();
    expect(requests.some((request) => request.path === "/api/den/v1/inference/access" && request.status === 200 && !request.faulted)).toBe(true);
    expect(requests.some((request) => request.path === `/api/den/v1/llm-providers/${world.registeredProviderId}/connect` && request.status === 200 && !request.faulted)).toBe(true);
    await user.notSee({ testId: "inference-upgrade-dialog" });
    await user.click({ role: "button", label: "Change model" });
    // Search and rows are the first surface, not a legacy Model submenu.
    await user.see(search);
    await user.see({ text: "Recommended by OpenWork" });
    await user.see({ ...own, label: "Big Pickle, current model" });
    for (const model of world.catalog.filter((model) => model.recommended)) {
      await user.see(row(model.modelID), { text: contains(model.summary) });
    }
    await user.see({ ...luna, label: `${world.luna.displayName}, Free` });
    await user.see({ ...astra, label: `${world.astra.displayName}, Upgrade, opens upgrade options without changing your model` });
    await user.see({ testId: "inference-allowance" }, { text: /\$1\.00 of \$1\.00 left this week/ });
    await user.see({ role: "button", label: "See all models" });
    await user.see({ testId: "model-own-provider" });
    for (const removed of [
      "Your API keys", "Add your keys", "hosted · no API keys",
      "One subscription unlocks these in every workspace.", "Enable →", "Sign in →", "Hide",
    ]) await user.notSee({ text: removed });
    await user.notSee({ role: "button", label: "Subscribe" });
    await user.notSee({ testId: "inference-upgrade-dialog" });
    await unchanged(initial.selectedModelLabel);
    // Supplementary capture only; no vision key or vision verdict is required.
    await user.screenshot();
  });

  await step("a free selection preserves the draft, favorite, and accessible effort controls", async () => {
    await user.click({ role: "button", label: "Add Big Pickle to favorites" });
    await user.see({ role: "button", label: "Remove Big Pickle from favorites" });
    await unchanged(initial.selectedModelLabel);
    await user.click(luna);
    await user.notSee({ testId: "managed-model-picker" });
    await user.see({ role: "button", label: "Change model" }, { text: contains(world.luna.displayName) });
    await user.see("composer", { text: draft });
    await user.click({ role: "button", label: "Change model" });
    await user.see({ text: "Favorites" });
    await user.see({ role: "button", label: "Remove Big Pickle from favorites" });
    await user.see({ ...luna, label: `${world.luna.displayName}, Free, current model` });
    await user.click({ role: "button", label: /^Thinking and effort for .*Luna/ });
    await user.see({ role: "button", label: "Back to models" });
    await user.see({ role: "button", label: "Low" });
    await user.click({ role: "button", label: "Low" });
    await user.see({ role: "button", label: "Change model" }, { text: /Luna[\s\S]*Low/ });
    await user.notSee({ testId: "inference-upgrade-dialog" });
  });
  const selectedLuna = (await probe.composer()).selectedModelLabel;
  await unchanged(selectedLuna);

  await step("the full picker searches the real catalog and labels paid rows before clicking", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: "See all models" });
    await user.see({ testId: "all-models-picker" });
    await user.see({ text: "Select a model for this session." });
    await user.see(search);
    await user.see({ role: "button", label: "Done" });
    await user.notSee({ role: "button", label: "Hide OpenWork Models" });
    await user.notSee({ text: "Subscribe to use hosted frontier models in this workspace." });
    await user.notSee({ text: "Sign in to unlock hosted frontier models for your team." });
    await user.notSee({ role: "button", label: "Subscribe" });
    await user.notSee({ testId: "inference-upgrade-dialog" });
    await user.see({ ...luna, label: `${world.luna.displayName}, Free, current model` });
    await user.type(search, world.astra.summary, { replace: true });
    await user.see(astra, { text: contains(world.astra.summary) });
    await user.see({ ...astra, label: `${world.astra.displayName}, Upgrade, opens upgrade options without changing your model` });
    await user.notSee(luna);
    await user.type(search, "Big Pickle", { replace: true });
    await user.see({ ...own, label: "Big Pickle" });
    await user.see({ role: "button", label: "Remove Big Pickle from favorites" });
    await user.notSee({ testId: "model-access-label" });
    await user.click({ role: "button", label: "Done" });
    await unchanged(selectedLuna);
  });

  await step("choosing paid Astra opens only its contextual offer; Close and Keep using Luna do not run a task", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.see({ ...astra, label: `${world.astra.displayName}, Upgrade, opens upgrade options without changing your model` });
    await user.click(astra);
    await user.see({ testId: "inference-upgrade-dialog" }, { text: contains(`Unlock ${world.astra.displayName}`) });
    await user.see({ testId: "inference-upgrade-dialog" }, { text: contains(world.astra.summary) });
    await user.see({ testId: "inference-upgrade-plan" }, { text: contains(world.plan.usageLabel) });
    await user.see({ testId: "inference-upgrade-plan" }, { text: contains(world.plan.name) });
    await user.see({ testId: "inference-view-upgrade" });
    await unchanged(selectedLuna);
    await user.click({ role: "button", label: /^Close$/ });
    await user.notSee({ testId: "inference-upgrade-dialog" });
    await unchanged(selectedLuna);
    await user.click({ role: "button", label: "Change model" });
    await user.click(astra);
    await user.click({ role: "button", label: "Keep using Luna" });
    await user.notSee({ testId: "inference-upgrade-dialog" });
    await user.notSee({ testId: "all-models-picker" });
    await user.notSee({ testId: "managed-model-picker" });
    await unchanged(selectedLuna);
  });

  await step("Use my own provider opens Connect providers directly, without keys or documentation tabs", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ testId: "model-own-provider" });
    await user.see({ text: "Connect providers" });
    await user.see({ placeholder: "Filter providers by name or ID" });
    await user.notSee({ testId: "inference-upgrade-dialog" });
    await user.notSee({ role: "button", label: "Save key" });
    await unchanged(selectedLuna);
    await user.press("Escape");
    await user.notSee({ placeholder: "Filter providers by name or ID" });
  });

  await step("a fixture non-admin access report shows Ask admin and no checkout action", async () => {
    await world.seedFault("non-admin");
    await user.click({ role: "button", label: "Change model" });
    await user.click(astra);
    await user.see({ testId: "inference-ask-admin" }, { timeoutMs: 70_000, text: /Ask a workspace owner or admin/ });
    await user.notSee({ testId: "inference-view-upgrade" });
    await user.notSee({ testId: "inference-use-model" });
    await unchanged(selectedLuna);
  });

  await step("a fixture paid access report makes Astra ready but still requires explicit confirmation in the full picker", async () => {
    // No billing mutation, checkout, purchase, or inference is performed here.
    // The normal focus/interval refresh consumes the fixture-owned access response.
    await world.seedFault("paid");
    await user.see({ testId: "inference-upgrade-dialog" }, { timeoutMs: 70_000, text: contains(`${world.astra.displayName} is ready to use`) });
    await user.notSee({ testId: "inference-view-upgrade" });
    await user.notSee({ testId: "inference-ask-admin" });
    await unchanged(selectedLuna);
    await user.click({ testId: "inference-use-model" });
    await user.see({ testId: "all-models-picker" });
    await user.see({ testId: "requested-model-ready" }, { text: contains(`Select ${world.astra.displayName}`) });
    await user.see(search, { value: world.astra.modelID });
    await user.see({ ...astra, label: `${world.astra.displayName}, Included` });
    expect((await probe.dom(`[data-requested="true"] [data-testid="${astra.testId}"]`)).elements).toHaveLength(1);
    await unchanged(selectedLuna);
    await user.click(astra);
    await user.notSee({ testId: "all-models-picker" });
    await user.see({ role: "button", label: "Change model" }, { text: contains(world.astra.displayName) });
    const selectedAstra = (await probe.composer()).selectedModelLabel;
    await unchanged(selectedAstra);
    await user.click({ role: "button", label: "Change model" });
    await user.see({ ...astra, label: `${world.astra.displayName}, Included, current model` });
    await user.see({ ...luna, label: `${world.luna.displayName}, Included` });
    await user.see({ role: "button", label: "Remove Big Pickle from favorites" });
    await user.press("Escape");
    await unchanged(selectedAstra);
    // Bypass the fixture to verify that the actual account is still free.
    const realAccess = await probe.api(world.den.admin, world.accessPath);
    expect(realAccess.body).toEqual(world.freeResponse);
  });
});
