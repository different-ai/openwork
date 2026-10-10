import { expect } from "vitest";
import { spec, type Probe, type Target, type User } from "@openwork/testkit";
import { denWorkbotSettings, denWorkbotSettingsShortList } from "../worlds/den-workbot-settings.ts";

const settingsPath = "/v1/org/workbot-settings";
const cardSelector = '[data-section="workbot-default-model"]';
// Observe the popup's semantic parent on both the old inline menu and the
// repaired portal; the control must fail at the real clipping/hit-test witness.
const popupSelector = 'div:has(> [role="listbox"])';
const triggerSelector = '[data-testid="workbot-settings-screen"] button[aria-haspopup="listbox"]';
const chooser = { role: "button", label: "Default model" } satisfies Target;
const search = { role: "combobox", label: "Search models" } satisfies Target;
const test = spec.world(denWorkbotSettings, {
  timeout: 900_000,
  resources: { surfaces: ["web"], services: ["den", "mock"] },
  needs: { placement: "local", commands: ["pnpm", "bun"], optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
});
const shortList = spec.world(denWorkbotSettingsShortList, {
  timeout: 900_000,
  resources: { surfaces: ["web"], services: ["den", "mock"] },
  needs: { placement: "local", commands: ["pnpm", "bun"], optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
});

async function popupGeometry(probe: Probe) {
  let previous = "";
  return probe.eventually(() => probe.dom(popupSelector), {
    within: 10_000, label: "the open model list has settled geometry",
    until: (snapshot) => {
      const geometry = JSON.stringify(snapshot);
      const settled = geometry === previous;
      previous = geometry;
      const rect = snapshot.elements[0]?.rect;
      return settled && snapshot.elements.length === 1 && Boolean(rect && rect.width > 0 && rect.left >= 7 && rect.top >= 7);
    },
  });
}

function expectInsideViewport(snapshot: Awaited<ReturnType<Probe["dom"]>>, height: number) {
  const popup = snapshot.elements[0];
  if (!popup) throw new Error("The model list is missing");
  expect(snapshot.documentWidth).toBeLessThanOrEqual(snapshot.viewportWidth);
  expect(popup.rect.left).toBeGreaterThanOrEqual(7);
  expect(popup.rect.right).toBeLessThanOrEqual(snapshot.viewportWidth - 7);
  expect(popup.rect.top).toBeGreaterThanOrEqual(7);
  expect(popup.rect.bottom).toBeLessThanOrEqual(height - 7);
  return popup.rect;
}

async function expectListClosed(user: User, probe: Probe) {
  // Base UI commits dismissal after the input event. Observe that bounded
  // transition before requiring stable absence; denied-member checks remain immediate.
  await probe.eventually(async () => (await probe.dom('[role="listbox"]')).elements.length, {
    within: 5_000,
    label: "the model list finishes closing",
    until: (count) => count === 0,
  });
  await user.notSee({ role: "listbox" });
}

async function expectTriggerFocused(probe: Probe) {
  const snapshot = await probe.eventually(() => probe.dom(triggerSelector), {
    within: 5_000, label: "focus returns to Default model", until: (value) => value.elements[0]?.focused === true,
  });
  expect(snapshot.elements[0]?.focused).toBe(true);
}

test("an owner chooses Workbot's model beyond the rounded settings card and can undo it on small screens", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const chosen = world.models[3];
  const last = world.models[world.models.length - 1];
  if (!chosen || !last) throw new Error("The clipping proof needs a long catalog");

  await step("before: the owner sees the cloud default and more than eight available models", async () => {
    await owner.see({ testId: "workbot-settings-screen" }, { timeoutMs: 120_000 });
    await owner.see(chooser, { text: `Default (${world.defaultModel.name})` });
    const context = await probe.api(world.den.admin, "/v1/org");
    const settings = await probe.api(world.den.admin, settingsPath);
    expect(context.body).toMatchObject({ currentMember: { isOwner: true } });
    expect(settings.body).toMatchObject({ model: null, runnerReachable: true, models: world.models });
    expect(world.models.length).toBeGreaterThan(8);
    const requests = world.runnerRequests();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.method === "GET" && request.path === "/v1/models" && request.authorized)).toBe(true);
    evidence.recordAssertionEvidence("the real owner reads the runner's complete catalog", `${world.models.length} deterministic models; saved model is the cloud default; ${requests.length} authenticated catalog reads and no model runs`, true);
    await owner.screenshot();
  });

  await step("the owner opens the complete model list outside the rounded card", async () => {
    await owner.click(chooser);
    const snapshot = await popupGeometry(page);
    const popup = expectInsideViewport(snapshot, 900);
    const card = (await page.dom(cardSelector)).elements[0]?.rect;
    if (!card) throw new Error("The actual Workbot settings card is missing");
    expect(popup.bottom).toBeGreaterThan(card.bottom);
    expect((await page.dom('[role="option"]')).elements).toHaveLength(world.models.length + 1);
    const focus = await page.dom(`${triggerSelector}, input[aria-label="Search models"]`);
    expect(focus.elements.some((element) => element.focused)).toBe(true);
    evidence.recordAssertionEvidence("the list crosses the actual settings-card bottom", `card bottom ${card.bottom.toFixed(1)}px; open list bottom ${popup.bottom.toFixed(1)}px; ${world.models.length + 1} choices, including the default; the chooser keeps focus`, popup.bottom > card.bottom);
    await owner.screenshot();
  });

  await step("a choice below the card's clipping boundary accepts the owner's click", async () => {
    const card = (await page.dom(cardSelector)).elements[0]?.rect;
    const option = (await page.dom('[role="option"]')).elements.find((entry) => entry.text === chosen.name)?.rect;
    if (!card || !option) throw new Error("The below-card choice is missing");
    const center = (option.top + option.bottom) / 2;
    expect(center).toBeGreaterThan(card.bottom);
    // Keep the popup open in the evidence. The following trusted click's hit
    // test is the witness; positive DOM bounds alone also pass on clipped menus.
    await owner.screenshot();
    const hit = await world.optionHitTest(4, { x: (option.left + option.right) / 2, y: center });
    evidence.recordAssertionEvidence("the below-card choice owns its pointer target before automatic scrolling", `option center ${center.toFixed(1)}px; card bottom ${card.bottom.toFixed(1)}px; native hit belongs to this option: ${hit.hitsExpectedOption}`, hit.hitsExpectedOption);
    expect(hit.hitsExpectedOption).toBe(true);
    await owner.click({ role: "option", label: chosen.name });
    await expectListClosed(owner, page);
    await owner.see(chooser, { text: chosen.name });
    await expectTriggerFocused(page);
    expect((await probe.api(world.den.admin, settingsPath)).body).toMatchObject({ model: null });
  });

  await step("after: Save model persists the selected choice for new messages", async () => {
    await owner.click({ role: "button", label: "Save model" });
    await owner.see({ text: `Saved. New messages use ${chosen.name}.` }, { timeoutMs: 30_000 });
    const settings = await probe.api(world.den.admin, settingsPath);
    expect(settings.body).toMatchObject({ model: chosen.id });
    await owner.reload();
    await owner.see(chooser, { text: chosen.name, timeoutMs: 60_000 });
    evidence.recordAssertionEvidence("the choice is saved and survives reload", `Den saved ${chosen.name}; the reloaded Default model control shows the same choice`, true);
    await owner.screenshot();
  });

  await step("the owner saves another choice and Undo restores the previous model", async () => {
    await owner.click(chooser);
    await owner.type(search, "Atlas", { replace: true });
    await owner.press("End");
    await owner.press("Enter");
    await owner.click({ role: "button", label: "Save model" });
    await owner.see({ text: `Saved. New messages use ${world.defaultModel.name}.` }, { timeoutMs: 30_000 });
    await owner.click({ role: "button", label: "Undo" });
    await owner.see({ text: `Saved. New messages use ${chosen.name}.` }, { timeoutMs: 30_000 });
    expect((await probe.api(world.den.admin, settingsPath)).body).toMatchObject({ model: chosen.id });
    await owner.see(chooser, { text: chosen.name });
    evidence.recordAssertionEvidence("Undo restores the saved model rather than just the label", `Saved ${world.defaultModel.name}, then Undo restored ${chosen.name} in both the control and Den`, true);
    await owner.screenshot();
  });

  await step("search stays focused inside the portaled list, including when nothing matches", async () => {
    await owner.click(chooser);
    await owner.type(search, "no-such-model", { replace: true });
    await owner.see({ text: "No options match this search." });
    expect((await page.dom('[role="option"]')).elements).toHaveLength(0);
    expect((await page.dom('input[aria-label="Search models"]')).elements[0]?.focused).toBe(true);
    expect((await page.dom(popupSelector)).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("focusing and filtering the portal does not dismiss it", "Search retains focus; the list stays open with zero matching options and the no-results state", true);
    await owner.screenshot();
  });

  await step("Escape closes only the model list and returns focus without changing the saved choice", async () => {
    await owner.press("Escape");
    await expectListClosed(owner, page);
    await expectTriggerFocused(page);
    await owner.see(chooser, { text: chosen.name });
    expect((await probe.api(world.den.admin, settingsPath)).body).toMatchObject({ model: chosen.id });
    evidence.recordAssertionEvidence("Escape is a reversible dismissal", `The list is closed, Default model is focused, and ${chosen.name} is still saved`, true);
    await owner.screenshot();
  });

  await step("clicking outside the model list dismisses it without saving or losing the draft", async () => {
    await owner.click(chooser);
    await owner.see(search);
    await popupGeometry(page);
    await owner.screenshot();
    await owner.click({ role: "heading", label: "Workbot" });
    await expectListClosed(owner, page);
    await owner.see(chooser, { text: chosen.name });
    expect((await probe.api(world.den.admin, settingsPath)).body).toMatchObject({ model: chosen.id });
    evidence.recordAssertionEvidence("an outside click is dismissal, not selection", `Clicking the page heading closes the list; ${chosen.name} remains the draft and saved choice`, true);
  });

  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 667, height: 375 }]) {
    await step(`after: at ${viewport.width} × ${viewport.height}, the last long model stays reachable without sideways scrolling`, async () => {
      await owner.resizeViewport({ ...viewport, deviceScaleFactor: 1 });
      await owner.click(chooser);
      await owner.see(search);
      await owner.press("End");
      const snapshot = await popupGeometry(page);
      const popup = expectInsideViewport(snapshot, viewport.height);
      const finalOption = await page.eventually(async () => (await page.dom('[role="option"]')).elements.find((entry) => entry.text === last.name), {
        within: 5_000, label: "End brings the final choice into the list's scroll window",
        until: (option) => Boolean(option && option.rect.top >= popup.top && option.rect.bottom <= popup.bottom),
      });
      if (!finalOption) throw new Error("The last model is missing");
      expect(finalOption.rect.top).toBeGreaterThanOrEqual(popup.top);
      expect(finalOption.rect.bottom).toBeLessThanOrEqual(popup.bottom);
      if (viewport.height === 375) {
        const trigger = (await page.dom(triggerSelector)).elements[0]?.rect;
        if (!trigger) throw new Error("The model control is missing");
        expect(popup.bottom).toBeLessThanOrEqual(trigger.top);
        expect(popup.height).toBeLessThan(330);
      }
      await owner.screenshot();
      await owner.click({ role: "option", label: last.name });
      await owner.see(chooser, { text: last.name });
      await expectTriggerFocused(page);
      expect((await probe.api(world.den.admin, settingsPath)).body).toMatchObject({ model: chosen.id });
      evidence.recordAssertionEvidence("the bounded list can scroll to and select its final long label", `${viewport.width}×${viewport.height}: document ${snapshot.documentWidth}px; list [${popup.left.toFixed(1)}, ${popup.top.toFixed(1)}]–[${popup.right.toFixed(1)}, ${popup.bottom.toFixed(1)}]; End reveals the last of ${world.models.length} models and its trusted click changes only the draft${viewport.height === 375 ? "; the list flips above the control and shrinks to the available height" : ""}`, true);
    });
  }

  await step("the long-label choice can be saved on the short screen and Undo restores the earlier model", async () => {
    await owner.click({ role: "button", label: "Save model" });
    await owner.see({ text: `Saved. New messages use ${last.name}.` }, { timeoutMs: 30_000 });
    expect((await probe.api(world.den.admin, settingsPath)).body).toMatchObject({ model: last.id });
    const savedLayout = await page.dom(cardSelector);
    expect(savedLayout.documentWidth).toBeLessThanOrEqual(savedLayout.viewportWidth);
    await owner.screenshot();
    await owner.click({ role: "button", label: "Undo" });
    await owner.see(chooser, { text: chosen.name, timeoutMs: 30_000 });
    expect((await probe.api(world.den.admin, settingsPath)).body).toMatchObject({ model: chosen.id });
    evidence.recordAssertionEvidence("short-screen save and Undo still use the real settings API", `${last.name} saved at 667×375; Undo restored ${chosen.name}`, true);
    await owner.screenshot();
  });

  await step("a teammate with view-only access sees the current model but cannot open or save the chooser", async () => {
    const reader = user.on(world.readerWeb);
    await reader.reload();
    await reader.see({ testId: "workbot-settings-screen" }, { timeoutMs: 60_000 });
    await reader.see(chooser, { text: chosen.name });
    await reader.see({ text: /Read only\./ });
    await reader.notSee({ role: "button", label: "Save model" });
    await expect(reader.click(chooser)).rejects.toThrow(/disabled/i);
    await reader.notSee({ role: "listbox" });
    const settings = await probe.api(world.reader, settingsPath);
    const readerContext = await probe.api(world.reader, "/v1/org");
    expect(settings.response.status).toBe(200);
    expect(settings.body).toMatchObject({ model: chosen.id });
    expect(readerContext.body).toMatchObject({ currentMember: { permissions: expect.arrayContaining(["inference.view"]) } });
    expect(readerContext.body).not.toMatchObject({ currentMember: { permissions: expect.arrayContaining(["inference.manage"]) } });
    evidence.recordAssertionEvidence("portaling never bypasses disabled or read-only access", "The view-only teammate reads the saved model and its permission reason; the disabled chooser does not open and there is no Save model action", true);
    await reader.screenshot();
  });
});

shortList("an owner keeps keyboard selection and the cloud-default value with a short model list", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const last = world.models[world.models.length - 1];
  if (!last) throw new Error("The short model catalog is empty");

  await step("the owner opens a short list with the keyboard and no search field", async () => {
    await owner.see(chooser, { timeoutMs: 120_000 });
    await owner.click(chooser);
    await owner.press("Escape");
    await expectTriggerFocused(page);
    await owner.press("ArrowDown");
    await owner.see({ role: "listbox" });
    await owner.notSee(search);
    await expectTriggerFocused(page);
    expect((await page.dom('[role="option"]')).elements).toHaveLength(4);
    evidence.recordAssertionEvidence("the short-list trigger retains keyboard focus", "ArrowDown opens all three models plus Default without a search field; Default model retains focus", true);
    await owner.screenshot();
  });

  await step("End and Enter choose the last model and keep focus on Default model", async () => {
    await owner.press("End");
    await owner.press("Enter");
    await expectListClosed(owner, page);
    await owner.see(chooser, { text: last.name });
    await expectTriggerFocused(page);
    expect((await probe.api(world.den.admin, settingsPath)).body).toMatchObject({ model: null });
    evidence.recordAssertionEvidence("keyboard selection changes only the draft", `End and Enter choose ${last.name}; popup closes, focus returns, saved choice remains Default`, true);
    await owner.screenshot();
  });

  await step("Home and Enter restore the empty cloud-default value without saving a model", async () => {
    await owner.press("Space");
    await owner.see({ role: "listbox" });
    await owner.press("Home");
    await owner.press("Enter");
    await owner.see(chooser, { text: `Default (${world.defaultModel.name})` });
    await expectListClosed(owner, page);
    await expectTriggerFocused(page);
    expect((await probe.api(world.den.admin, settingsPath)).body).toMatchObject({ model: null });
    evidence.recordAssertionEvidence("the empty Default option remains selectable by keyboard", "Space opens the list; Home and Enter restore Default; no model is saved and the control keeps focus", true);
    await owner.screenshot();
  });
});
