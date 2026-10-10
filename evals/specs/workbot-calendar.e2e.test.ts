import { expect } from "vitest";
import { spec, type Probe, type User } from "@openwork/testkit";
import { workbotCalendar, workbotCalendarShortList } from "../worlds/workbot-calendar.ts";

const modelTrigger = { label: "Model" };
const modelSearch = { label: "Search models" };

async function menuLayout(probe: Probe, height: number) {
  // Include the outer popup when present, plus both the list and search on the old implementation so a
  // baseline run fails on observed geometry rather than just on a new implementation-specific marker.
  const snapshot = await probe.dom('[data-workbot-model-popup], [role="listbox"], input[aria-label="Search models"]');
  const rects = snapshot.elements.map((element) => element.rect);
  const fits = rects.length > 0 && rects.every((rect) => rect.width > 0 && rect.height > 0
    && rect.left >= 7 && rect.top >= 7 && rect.right <= snapshot.viewportWidth - 7 && rect.bottom <= height - 7);
  return { fits, noSidewaysScroll: snapshot.documentWidth <= snapshot.viewportWidth,
    description: `${snapshot.viewportWidth}×${height}; page ${snapshot.documentWidth}px; floating bounds ${JSON.stringify(rects.map((rect) => ({ left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom) })))}` };
}

async function highlightModel(user: User, probe: Probe, name: string) {
  const choices = (await probe.dom('[role="listbox"] [role="option"]')).elements.length;
  for (let index = 0; index <= choices; index++) {
    const highlighted = (await probe.dom('[role="option"][data-highlighted]')).elements[0]?.text ?? "";
    if (highlighted === name) return;
    await user.press("ArrowDown");
  }
  expect((await probe.dom('[role="option"][data-highlighted]')).elements[0]?.text).toBe(name);
}

async function lastModelIsInView(probe: Probe, name: string) {
  const list = (await probe.dom('[role="listbox"]')).elements[0]?.rect;
  const last = (await probe.dom('[role="listbox"] [role="option"]')).elements.at(-1);
  return Boolean(list && last && last.text === name && last.rect.top >= list.top - 1 && last.rect.bottom <= list.bottom + 1);
}

async function modelHasFocus(probe: Probe) {
  return (await probe.dom('[aria-label="Model"]')).elements.some((element) => element.focused);
}

async function expectModelListClosed(user: User, probe: Probe, readPaintState: Awaited<ReturnType<typeof workbotCalendar>>["modelListPaintState"]) {
  // Select retains hidden options for typeahead; Combobox may unmount them. Wait for actual computed paint
  // absence and a closed trigger, then independently require the same three seconds of stable user-visible absence.
  const closed = await probe.eventually(readPaintState, {
    within: 5_000,
    label: "the model list stops painting after the member's action",
    until: (state) => state.painted === 0 && state.triggerExists && !state.expanded,
  });
  await user.notSee({ role: "listbox" });
  return closed;
}

const test = spec.world(workbotCalendar, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { placement: "local", optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
  timeout: 900_000,
});

test("a Workbot member sees their Automations next to Google and Outlook meetings and pauses one, behind Workbot's own Calendar switch", async ({ world, user, probe, step, evidence }) => {
  const count = async (selector: string) => (await probe.dom(selector)).elements.length;
  const lastModel = world.pickerModels.at(-1);
  if (!lastModel) throw new Error("The picker world needs a last model");

  await step("Alex opens Workbot's Calendar and sees this week's Automations next to Google and Outlook meetings", async () => {
    await user.navigate(`${world.url}/calendar`);
    await user.see({ role: "button", label: /^Launch standup, Google Calendar/ }, { timeoutMs: 90_000 });
    await user.see({ role: "button", label: /^Partner pipeline review, Outlook Calendar/ });
    await user.see({ role: "button", label: /^Weekly launch update, / });
    const automations = await count("[data-calendar-automation]");
    const meetings = await count("[data-calendar-meeting]");
    const reads = world.providerReads();
    evidence.recordAssertionEvidence("both layers, read through Workbot and Den", `${automations} Automation blocks, ${meetings} meetings; ${reads} Google/Graph reads made by Den`, automations >= 5 && meetings >= 5 && reads >= 2);
    expect(automations).toBeGreaterThanOrEqual(5);
    expect(meetings).toBeGreaterThanOrEqual(5);
    expect(reads).toBeGreaterThanOrEqual(2);
    await user.screenshot();
  });

  await step("Alex opens the weekly launch update: when it repeats, where it runs, and a past run's result", async () => {
    await user.click({ role: "button", label: /^Weekly launch update, / });
    await user.see({ text: /^Every Friday at 3:00 PM/ });
    await user.see({ text: "The cloud. Your laptop can be closed." });
    await user.click({ role: "button", text: "Open", nth: 0 });
    await user.see({ text: /Drafted the weekly launch update|Slack sign-in expired/ });
    const runs = await count("[data-calendar-past-runs] li");
    evidence.recordAssertionEvidence("past runs come from Den's receipts", `${runs} past runs; the first opens its recorded result`, runs >= 1);
    expect(runs).toBeGreaterThanOrEqual(1);
    await user.screenshot();
  });

  await step("next week, an Automation that needs HubSpot shows a lock and no scheduled run", async () => {
    // Next week, so the slot is ahead of now whatever day the spec runs.
    const thisWeek = (await probe.dom("[data-calendar-range-label]")).elements[0]?.text ?? "";
    await user.click({ role: "button", label: "Next" });
    // Wait for next week to render, so the click below cannot land on this week's block as it unmounts.
    await probe.eventually(async () => (await probe.dom("[data-calendar-range-label]")).elements[0]?.text ?? "", { within: 15_000, label: "next week is on screen", until: (text) => text !== "" && text !== thisWeek });
    await user.click({ role: "button", label: /^Update launch deals, Blocked until fixed/ });
    await user.see({ text: "Not scheduled until fixed" });
    await user.see({ text: /Needs HubSpot access/ });
    const runNow = (await probe.dom("[data-calendar-detail] button[disabled]")).elements.map((element) => element.text);
    evidence.recordAssertionEvidence("blocked is not a confirmed run", `panel: "Not scheduled until fixed"; disabled: ${runNow.join(", ")}`, runNow.includes("Run now"));
    expect(runNow).toContain("Run now");
    await user.screenshot();
  });

  await step("after: pausing the weekly launch update removes its slot next week", async () => {
    await user.see({ role: "button", label: /^Weekly launch update, Scheduled/ });
    await user.click({ role: "button", label: /^Weekly launch update, Scheduled/ });
    await user.click({ role: "button", text: "Pause" });
    await user.see({ text: "Paused" });
    await user.notSee({ role: "button", label: /^Weekly launch update, Scheduled/ }, { timeoutMs: 15_000 });
    await user.see({ role: "button", text: "Resume" });
    evidence.recordAssertionEvidence("Pause went through Den", "next week's Friday slot is gone and the panel offers Resume", true);
    await user.screenshot();
  });

  await step("Alex opens a long model list from an empty Wednesday slot without losing the cloud default", async () => {
    await user.click({ role: "button", label: /^New automation on Wed, .* at 12:30 PM$/ });
    await user.see({ text: /Runs on .*'s cloud computer\./ });
    await user.type({ role: "textbox", label: /^What should .* do\?$/ }, "Check the launch checklist for anything still open");
    await user.click({ role: "radio", label: "Wednesdays" });
    await user.click(modelTrigger);
    await user.see(modelSearch);
    await user.screenshot();
    const choices = await count('[role="listbox"] [role="option"]');
    const logos = await count('[role="listbox"] [role="option"] svg[role="img"]');
    const layout = await menuLayout(probe, 960);
    const selected = (await probe.dom('[role="option"][aria-selected="true"]')).elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("the complete grouped list stays on screen", `${choices} choices, ${logos} vendor logos; selected "${selected}"; ${layout.description}`, choices === world.pickerModels.length + 1 && logos === world.pickerModels.length && /Cloud default/.test(selected) && layout.fits && layout.noSidewaysScroll);
    expect(choices).toBe(world.pickerModels.length + 1);
    expect(logos).toBe(world.pickerModels.length);
    expect(selected).toContain("Cloud default");
    expect(layout.fits && layout.noSidewaysScroll).toBe(true);
  });

  await step("Escape closes only the model list and leaves Alex's new Automation draft intact", async () => {
    await user.press("Escape");
    await expectModelListClosed(user, probe, world.modelListPaintState);
    await user.see({ role: "button", text: "Create automation" });
    await user.see({ role: "textbox", label: /^What should .* do\?$/ }, { value: "Check the launch checklist for anything still open" });
    const focused = await modelHasFocus(probe);
    const draft = await count("[data-calendar-create]");
    evidence.recordAssertionEvidence("dismissal returns to the model control, not the page", `${draft} creation form; model control focused ${focused}; instructions and cloud default unchanged`, draft === 1 && focused);
    expect(draft).toBe(1);
    expect(focused).toBe(true);
    await user.screenshot();
  });

  await step("after: Alex creates a cloud Automation that repeats in the Wednesday slot", async () => {
    await user.click({ role: "button", text: "Create automation" });
    await user.see({ text: "Automation created" });
    await user.see({ text: /^Every Wednesday at 12:30 PM/ });
    await user.see({ role: "button", label: /^Check the launch checklist for anything still open, Scheduled/ });
    const created = await count('[data-calendar-automation][aria-label^="Check the launch checklist"]');
    evidence.recordAssertionEvidence("created through Workbot and Den", `${created} new slot(s) on next week's grid; the panel shows "Every Wednesday at 12:30 PM"`, created >= 1);
    expect(created).toBeGreaterThanOrEqual(1);
    await user.screenshot();
  });

  await step("Alex reaches the last long-named model with arrow keys while editing the Automation", async () => {
    await user.click({ role: "button", text: "Edit" });
    await user.see({ text: "Cloud: Only connected accounts" });
    await user.type({ role: "textbox", label: "Instructions" }, "Check the launch checklist and list owners of anything still open", { replace: true });
    await user.click(modelTrigger);
    await user.see(modelSearch);
    await highlightModel(user, probe, lastModel.name);
    await user.screenshot();
    const reachable = await lastModelIsInView(probe, lastModel.name);
    const layout = await menuLayout(probe, 960);
    evidence.recordAssertionEvidence("arrow navigation scrolls the model list to its last choice", `last choice "${lastModel.name}" fully inside list ${reachable}; ${layout.description}`, reachable && layout.fits && layout.noSidewaysScroll);
    expect(reachable).toBe(true);
    expect(layout.fits && layout.noSidewaysScroll).toBe(true);
    // A trusted pointer click also witnesses that a portaled option isn't intercepted by the editor's backdrop.
    await user.click({ role: "option", label: lastModel.name });
    await expectModelListClosed(user, probe, world.modelListPaintState);
    expect(await modelHasFocus(probe)).toBe(true);
    await user.see({ role: "textbox", label: "Instructions" }, { value: "Check the launch checklist and list owners of anything still open" });
  });

  await step("a search with no matches keeps Alex in the editor with a clear empty result", async () => {
    await user.press("ArrowDown");
    await user.see(modelSearch);
    await user.type(modelSearch, "no-such-calendar-model", { replace: true });
    await user.see({ text: "No models match." });
    const choices = await count('[role="listbox"] [role="option"]');
    const editors = await count("[data-calendar-edit]");
    evidence.recordAssertionEvidence("search doesn't change the draft or dismiss the editor", `${choices} matching models; ${editors} editor; Save changes remains available`, choices === 0 && editors === 1);
    expect(choices).toBe(0);
    expect(editors).toBe(1);
    await user.screenshot();
  });

  await step("Alex searches by provider and model name, then chooses and saves with the keyboard", async () => {
    const firstModel = world.pickerModels[0];
    if (!firstModel) throw new Error("The picker world needs a first model");
    await user.type(modelSearch, `${firstModel.name} ${world.pickerProviderName}`, { replace: true });
    await user.see({ role: "option", label: firstModel.name });
    const choices = await count('[role="listbox"] [role="option"]');
    await user.screenshot();
    await user.press("Enter");
    await expectModelListClosed(user, probe, world.modelListPaintState);
    const focused = await modelHasFocus(probe);
    expect(focused).toBe(true);
    await user.press("Tab"); // Cancel.
    await user.press("Tab"); // Save changes.
    const saveFocused = (await probe.dom('[data-calendar-form-actions] button[type="submit"]')).elements[0]?.focused === true;
    expect(saveFocused).toBe(true);
    await user.press("Enter");
    await user.see({ text: "Automation updated" });
    await user.see({ text: "Check the launch checklist and list owners of anything still open" });
    const model = (await probe.dom("[data-calendar-detail] [data-automation-model]")).elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("keyboard selection and save persist through Workbot and Den", `${choices} provider-and-name match; selection returned focus ${focused}; keyboard Save focused ${saveFocused}; panel "${model}"`, choices === 1 && focused && saveFocused && model.startsWith(firstModel.name));
    expect(choices).toBe(1);
    expect(model.startsWith(firstModel.name)).toBe(true);
    await user.screenshot();
  });

  for (const viewport of [
    { width: 1280, height: 600 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
    { width: 667, height: 375 },
  ]) {
    await step(`after: the new Automation model list stays on screen at ${viewport.width}×${viewport.height}`, async () => {
      await user.resizeViewport({ ...viewport, deviceScaleFactor: 1 });
      await user.click({ role: "button", label: "New automation" });
      await user.see({ role: "textbox", label: /^What should .* do\?$/ });
      await user.type({ role: "textbox", label: /^What should .* do\?$/ }, "Keep this unsaved phone draft");
      await user.click(modelTrigger);
      await user.see(modelSearch);
      await highlightModel(user, probe, lastModel.name);
      await user.screenshot();
      const layout = await menuLayout(probe, viewport.height);
      const reachable = await lastModelIsInView(probe, lastModel.name);
      const form = (await probe.dom("[data-calendar-create]")).elements[0]?.rect;
      const formFits = Boolean(form && form.left >= 7 && form.top >= 7 && form.right <= viewport.width - 7 && form.bottom <= viewport.height - 7);
      evidence.recordAssertionEvidence("the new form and its last model fit without sideways scrolling", `form fits ${formFits}; last model fully visible ${reachable}; ${layout.description}`, formFits && reachable && layout.fits && layout.noSidewaysScroll);
      expect(formFits && reachable && layout.fits && layout.noSidewaysScroll).toBe(true);
      await user.press("Escape");
      await expectModelListClosed(user, probe, world.modelListPaintState);
      await user.see({ role: "textbox", label: /^What should .* do\?$/ }, { value: "Keep this unsaved phone draft" });
      expect(await modelHasFocus(probe)).toBe(true);
      await user.press("Escape");
      await user.notSee({ role: "textbox", label: /^What should .* do\?$/ });
    });

    await step(`after: Alex can search the editor's complete model list at ${viewport.width}×${viewport.height}`, async () => {
      await user.click({ role: "button", text: "Edit" });
      await user.click(modelTrigger);
      await user.see(modelSearch, { value: "" });
      await highlightModel(user, probe, lastModel.name);
      await user.screenshot();
      const layout = await menuLayout(probe, viewport.height);
      const reachable = await lastModelIsInView(probe, lastModel.name);
      const editor = (await probe.dom("[data-calendar-edit]")).elements[0]?.rect;
      const editorFits = Boolean(editor && editor.left >= 7 && editor.top >= 7 && editor.right <= viewport.width - 7 && editor.bottom <= viewport.height - 7);
      evidence.recordAssertionEvidence("the editor and its last choice stay within the viewport", `editor fits ${editorFits}; last model fully visible ${reachable}; ${layout.description}`, editorFits && reachable && layout.fits && layout.noSidewaysScroll);
      expect(editorFits && reachable && layout.fits && layout.noSidewaysScroll).toBe(true);
      await user.press("Escape");
      await expectModelListClosed(user, probe, world.modelListPaintState);
      await user.see({ role: "button", text: "Save changes" });
      expect(await modelHasFocus(probe)).toBe(true);
      await user.press("Escape");
      await user.notSee({ role: "textbox", label: "Instructions" });
      const returned = (await probe.dom("[data-calendar-detail] button")).elements.some((button) => button.text === "Edit" && button.focused);
      expect(returned).toBe(true);
    });
  }
  await user.resizeViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });

  await step("Workbot's Calendar has its own switch: turning it off stops Workbot's Calendar and leaves the desktop's on", async () => {
    await world.turnOffWorkbotCalendar();
    const features = await world.features();
    const status = await world.calendarApiStatus();
    evidence.recordAssertionEvidence("separate switches", `workbotCalendar ${features.workbotCalendar}, automationCalendar ${features.automationCalendar}; Workbot's Calendar API answers ${status}`, !features.workbotCalendar && features.automationCalendar && status === 403);
    expect(features).toEqual({ workbotCalendar: false, automationCalendar: true });
    expect(status).toBe(403);
    await user.see({ text: /^Every Wednesday at 12:30 PM/ });
  });
});

const shortListTest = spec.world(workbotCalendarShortList, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { placement: "local", optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
  timeout: 900_000,
});

shortListTest("a Workbot member chooses from a short model list with Home, End, typeahead and Enter", async ({ world, user, probe, step, evidence }) => {
  const first = world.pickerModels[0];
  const last = world.pickerModels.at(-1);
  if (!first || !last) throw new Error("The short picker world needs two models");

  await step("the member opens three grouped choices without an unnecessary search field", async () => {
    await user.navigate(`${world.url}/calendar`);
    await user.see({ role: "button", label: "New automation" }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "New automation" });
    await user.type({ role: "textbox", label: /^What should .* do\?$/ }, "Write the short-list keyboard checklist");
    await user.click(modelTrigger);
    await user.see({ role: "option", label: first.name });
    await user.notSee(modelSearch);
    await user.screenshot();
    const choices = (await probe.dom('[role="listbox"] [role="option"]')).elements.length;
    const layout = await menuLayout(probe, 960);
    evidence.recordAssertionEvidence("a short list keeps all choices and provider marks visible", `${choices} choices, no search field; ${layout.description}`, choices === 3 && layout.fits && layout.noSidewaysScroll);
    expect(choices).toBe(3);
    expect(layout.fits && layout.noSidewaysScroll).toBe(true);
  });

  await step("Escape returns to the model control and leaves the new Automation open", async () => {
    await user.press("Escape");
    const closed = await expectModelListClosed(user, probe, world.modelListPaintState);
    await user.see({ role: "textbox", label: /^What should .* do\?$/ }, { value: "Write the short-list keyboard checklist" });
    const focused = await modelHasFocus(probe);
    const forms = (await probe.dom("[data-calendar-create]")).elements.length;
    evidence.recordAssertionEvidence("the first Escape dismisses only the short list", `${forms} creation form; model control focused ${focused}; ${closed.retained} retained list(s), ${closed.painted} painted; trigger expanded ${closed.expanded}; computed visibility ${JSON.stringify(closed.lists)}; draft unchanged`, forms === 1 && focused && closed.painted === 0 && !closed.expanded);
    expect(forms).toBe(1);
    expect(focused).toBe(true);
    await user.screenshot();
  });

  await step("Home, End, arrows and typing a model's first letter reach the intended choices", async () => {
    await user.press("ArrowDown");
    await user.see({ role: "option", label: last.name });
    await user.press("End");
    const atEnd = (await probe.dom('[role="option"][data-highlighted]')).elements[0]?.text ?? "";
    expect(atEnd).toBe(last.name);
    await user.press("ArrowUp");
    const aboveEnd = (await probe.dom('[role="option"][data-highlighted]')).elements[0]?.text ?? "";
    expect(aboveEnd).toBe(first.name);
    await user.press("ArrowDown");
    expect((await probe.dom('[role="option"][data-highlighted]')).elements[0]?.text).toBe(last.name);
    await user.press("Home");
    const atHome = (await probe.dom('[role="option"][data-highlighted]')).elements[0]?.text ?? "";
    expect(atHome).toContain("Cloud default");
    await user.press("b");
    const typedLast = (await probe.dom('[role="option"][data-highlighted]')).elements[0]?.text ?? "";
    expect(typedLast).toBe(last.name);
    await user.screenshot();
    evidence.recordAssertionEvidence("the short list uses one coherent keyboard selection path", `End "${atEnd}"; Up "${aboveEnd}"; Home "${atHome}"; type b "${typedLast}"`, atEnd === last.name && aboveEnd === first.name && /Cloud default/.test(atHome) && typedLast === last.name);
    await user.press("Enter");
    await expectModelListClosed(user, probe, world.modelListPaintState);
    expect(await modelHasFocus(probe)).toBe(true);
  });

  await step("after: Enter chooses the model and the new cloud Automation keeps it after saving", async () => {
    await user.see({ role: "textbox", label: /^What should .* do\?$/ }, { value: "Write the short-list keyboard checklist" });
    await user.click({ role: "button", text: "Create automation" });
    await user.see({ text: "Automation created" });
    const chosen = (await probe.dom(`[data-calendar-detail] [data-automation-model="${world.pickerProviderId}/${last.id}"]`)).elements[0]?.text ?? "";
    await user.see({ text: "The cloud. Your laptop can be closed." });
    const cloud = (await probe.dom("[data-calendar-detail]")).elements[0]?.text.includes("The cloud. Your laptop can be closed.") === true;
    evidence.recordAssertionEvidence("the selected short-list model persists without changing where it runs", `saved model "${chosen}"; cloud placement ${cloud}`, chosen.startsWith(last.name) && cloud);
    expect(chosen.startsWith(last.name)).toBe(true);
    expect(cloud).toBe(true);
    await user.screenshot();
  });
});
