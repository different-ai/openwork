import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotCalendarLayout } from "../worlds/workbot-calendar-layout.ts";

type Bounds = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const fits = (rect: Bounds, width: number, height: number) => rect.left >= 11 && rect.right <= width - 11 && rect.top >= 11 && rect.bottom <= height - 11;
const boundsLine = (rect: Bounds) => `${Math.round(rect.left)},${Math.round(rect.top)} to ${Math.round(rect.right)},${Math.round(rect.bottom)}`;

const test = spec.world(workbotCalendarLayout, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { placement: "local", optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
  timeout: 900_000,
});

// This is a separate viewport journey: the functional Calendar/model-picker journey has another owner.
// The world composes its real Workbot, Den and provider fixtures, rather than substituting static markup.
test("a Workbot member keeps a readable Calendar and reachable automation forms on desktop and small screens", async ({ world, user, probe, step, evidence }) => {
  const element = async (selector: string) => {
    const snapshot = await probe.dom(selector);
    const first = snapshot.elements[0];
    if (!first) throw new Error(`Missing visible Calendar element: ${selector}`);
    return first;
  };
  let originalTop = 0;
  let originalToolbarHeight = 0;
  const instructions = "Check the launch checklist";
  const updatedInstructions = "Check the launch checklist and list any remaining owners";

  await step("before navigation: the member reads this week's hours beside Google and Outlook meetings", async () => {
    await user.navigate(`${world.url}/calendar`);
    await user.see({ role: "button", label: /^Launch standup, Google Calendar/ }, { timeoutMs: 90_000 });
    await user.see({ role: "button", label: /^Partner pipeline review, Outlook Calendar/ });
    await user.click({ role: "button", label: /^Weekly launch update, / });
    originalTop = (await element('[data-calendar-grid="week"]')).rect.top;
    originalToolbarHeight = (await element("[data-calendar-toolbar]")).rect.height;
    const hours = (await probe.dom("[data-calendar-hour]")).elements.length;
    const rail = await world.hourRail();
    const reads = world.providerReads();
    const ok = hours >= 10 && rail.contrast >= 4.5 && rail.fontSize >= 12 && reads >= 2;
    evidence.recordAssertionEvidence("the hour rail is readable against the actual Calendar surface", `${hours} labels at ${rail.fontSize}px; ${rail.foreground} on ${rail.background} = ${rail.contrast.toFixed(2)}:1; ${reads} provider reads; grid starts at ${originalTop}px`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("the failed run shows the complete Slack recovery instruction instead of hiding the next step", async () => {
    const recovery = "Slack sign-in expired. Reconnect Slack in Your Connections.";
    await user.see({ text: recovery });
    const outcome = await element('[data-calendar-run-outcome][data-calendar-run-status="failed"]');
    const panel = await element("[data-calendar-detail]");
    const layout = await world.runRecoveryLayout();
    const ok = outcome.text === recovery && outcome.rect.height > 16 && outcome.rect.right <= panel.rect.right && layout.whiteSpace !== "nowrap" && layout.textOverflow !== "ellipsis" && layout.overflowX === "visible";
    evidence.recordAssertionEvidence("the error and its next action are both visible in the past-run row", `"${outcome.text}"; wraps to ${Math.round(outcome.rect.height)}px; white-space ${layout.whiteSpace}, overflow ${layout.overflowX}, text-overflow ${layout.textOverflow}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("after navigation: next week's grid stays in the same place while Today becomes available", async () => {
    const currentWeek = (await element("[data-calendar-range-label]")).text;
    await user.click({ role: "button", label: "Next" });
    await probe.eventually(async () => (await element("[data-calendar-range-label]")).text, { within: 15_000, label: "the member is looking at another week", until: (text) => text !== currentWeek });
    await user.see({ role: "button", label: /^Weekly launch update, Scheduled/ });
    await user.see({ role: "button", label: "Today" });
    const nextTop = (await element('[data-calendar-grid="week"]')).rect.top;
    const toolbarHeight = (await element("[data-calendar-toolbar]")).rect.height;
    const todayAvailable = (await probe.dom("[data-calendar-today]:not([disabled])")).elements.length === 1;
    const stable = Math.abs(nextTop - originalTop) <= 1 && Math.abs(toolbarHeight - originalToolbarHeight) <= 1 && todayAvailable;
    evidence.recordAssertionEvidence("changing weeks does not move the Calendar rows", `current grid ${originalTop}px → next grid ${nextTop}px; toolbar ${originalToolbarHeight}px → ${toolbarHeight}px; Today enabled ${todayAvailable}`, stable);
    expect(stable).toBe(true);
    await user.screenshot();
  });

  await step("a blocked connection names the workspace admin who can help rather than offering a nonexistent Connect link", async () => {
    await user.click({ role: "button", label: /^Update launch deals, Blocked until fixed/ });
    await user.see({ text: "Needs HubSpot access" });
    await user.see({ text: "Ask your workspace admin to help restore the connection access this automation needs." });
    const notice = await element("[data-calendar-blocked]");
    const links = (await probe.dom("[data-calendar-blocked] a")).elements.length;
    const ok = notice.text.includes("workspace admin") && !notice.text.includes("Connect HubSpot so") && links === 0;
    evidence.recordAssertionEvidence("the blocked state gives an honest owner and recovery direction", `${notice.text}; ${links} fabricated service links; Run now remains disabled`, ok && (await probe.dom('[data-calendar-detail] button[disabled]')).elements.some((button) => button.text === "Run now"));
    expect(ok).toBe(true);
    expect((await probe.dom('[data-calendar-detail] button[disabled]')).elements.some((button) => button.text === "Run now")).toBe(true);
    await user.screenshot();
  });

  await step("on a 320px phone, selected details sit below a full-width grid instead of crowding it", async () => {
    await user.resizeViewport({ width: 320, height: 568, deviceScaleFactor: 1 });
    await user.see({ role: "radio", label: "Week" });
    const grid = (await element('[data-calendar-grid="week"]')).rect;
    const detail = (await element("[data-calendar-detail]")).rect;
    const page = await probe.dom("[data-calendar-page]");
    const ok = grid.width >= 280 && detail.width <= 320 && detail.left >= 0 && detail.right <= 320 && detail.top >= grid.bottom - 1 && page.documentWidth <= page.viewportWidth;
    evidence.recordAssertionEvidence("phone selection keeps both layers usable without sideways scrolling", `grid ${Math.round(grid.width)}px; details ${Math.round(detail.width)}px below grid ${Math.round(grid.bottom)}px at ${Math.round(detail.top)}px; document ${page.documentWidth}px / viewport ${page.viewportWidth}px`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("the member opens New automation on the phone with its fields and actions inside the screen", async () => {
    await user.click({ role: "button", label: "New automation" });
    await user.type({ role: "textbox", label: /^What should .* do\?$/ }, instructions);
    const form = (await element("[data-calendar-create]")).rect;
    const actions = (await element("[data-calendar-create] [data-calendar-form-actions]")).rect;
    const page = await probe.dom("[data-calendar-create]");
    const focused = (await probe.dom("[data-calendar-create] textarea")).elements.some((field) => field.focused);
    const ok = fits(form, 320, 568) && actions.bottom <= form.bottom && actions.top >= form.top && focused && page.documentWidth <= page.viewportWidth;
    evidence.recordAssertionEvidence("the phone form is bounded and focuses the instructions field", `form ${boundsLine(form)}; actions end at ${Math.round(actions.bottom)}px; instructions focused ${focused}; document ${page.documentWidth}px / viewport ${page.viewportWidth}px`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("rotating to a short landscape screen keeps the open form and Create automation reachable", async () => {
    await user.resizeViewport({ width: 667, height: 375, deviceScaleFactor: 1 });
    await user.see({ role: "button", text: "Create automation" });
    const form = (await element("[data-calendar-create]")).rect;
    const actions = (await element("[data-calendar-create] [data-calendar-form-actions]")).rect;
    const body = (await element("[data-calendar-create] [data-calendar-form-body]")).rect;
    const page = await probe.dom("[data-calendar-create]");
    const ok = fits(form, 667, 375) && actions.bottom <= 363 && actions.top > body.bottom - 1 && body.height > 50 && page.documentWidth <= page.viewportWidth;
    evidence.recordAssertionEvidence("rotation repositions the real open card, not a guessed-height rectangle", `667×375; form ${boundsLine(form)}; scrollable fields ${Math.round(body.height)}px; actions ${boundsLine(actions)}; document ${page.documentWidth}px / viewport ${page.viewportWidth}px`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("after: Create automation saves the member's instructions in the cloud through Workbot and Den", async () => {
    await user.click({ role: "button", text: "Create automation" });
    await user.see({ text: "Automation created" }, { timeoutMs: 30_000 });
    await user.see({ text: instructions });
    const saved = await world.savedAutomation(instructions);
    const detail = (await element("[data-calendar-detail]")).rect;
    const ok = saved.instructions === instructions && saved.executionTarget === "cloud" && detail.width <= 667;
    evidence.recordAssertionEvidence("creation persists the form's body, not just a local success label", `Calendar GET: instructions "${saved.instructions}", runs on ${saved.executionTarget}; selected details ${Math.round(detail.width)}px in 667px viewport`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("on the short screen, the member reaches Time zone and saves changes without losing the footer", async () => {
    await user.click({ role: "button", text: "Edit" });
    await user.type({ role: "textbox", label: "Instructions" }, updatedInstructions, { replace: true });
    await user.click({ role: "textbox", label: "Time zone" });
    const form = (await element("[data-calendar-edit]")).rect;
    const actions = (await element("[data-calendar-edit] [data-calendar-form-actions]")).rect;
    const body = (await element("[data-calendar-edit] [data-calendar-form-body]")).rect;
    const fieldHeights = (await probe.dom("[data-calendar-edit] [data-calendar-form-body] > *")).elements.reduce((sum, field) => sum + field.rect.height, 0);
    const page = await probe.dom("[data-calendar-edit]");
    const bounded = fits(form, 667, 375) && actions.bottom <= 363 && actions.top >= body.bottom - 1 && fieldHeights > body.height && page.documentWidth <= page.viewportWidth;
    await user.screenshot();
    await user.click({ role: "button", text: "Save changes" });
    await user.see({ text: "Automation updated" }, { timeoutMs: 30_000 });
    const saved = await world.savedAutomation(instructions);
    const ok = bounded && saved.instructions === updatedInstructions && saved.executionTarget === "cloud";
    evidence.recordAssertionEvidence("the short editor scrolls its fields while keeping Save changes on screen", `form ${boundsLine(form)}; ${Math.round(fieldHeights)}px of fields in ${Math.round(body.height)}px body; footer ends at ${Math.round(actions.bottom)}px; Calendar GET instructions "${saved.instructions}"`, ok);
    expect(ok).toBe(true);
  });

  await step("back in portrait, the editor fits and Escape returns focus to Edit without changing the saved automation", async () => {
    await user.resizeViewport({ width: 320, height: 568, deviceScaleFactor: 1 });
    await user.click({ role: "button", text: "Edit" });
    await user.see({ role: "textbox", label: "Time zone" });
    const form = (await element("[data-calendar-edit]")).rect;
    const actions = (await element("[data-calendar-edit] [data-calendar-form-actions]")).rect;
    const page = await probe.dom("[data-calendar-edit]");
    const bounded = fits(form, 320, 568) && actions.bottom <= 556 && page.documentWidth <= page.viewportWidth;
    await user.screenshot();
    await user.press("Escape");
    await user.notSee({ text: "Edit automation" });
    const restored = await probe.eventually(async () => (await probe.dom("[data-calendar-detail] button")).elements.some((button) => button.text === "Edit" && button.focused), { within: 5_000, label: "Escape restores the member's Edit control", until: Boolean });
    const saved = await world.savedAutomation(instructions);
    const ok = bounded && restored && saved.instructions === updatedInstructions;
    evidence.recordAssertionEvidence("portrait dismissal restores focus and preserves the saved body", `320×568; form ${boundsLine(form)}; footer ${Math.round(actions.bottom)}px; Edit focus restored ${restored}; saved instructions unchanged ${saved.instructions === updatedInstructions}`, ok);
    expect(ok).toBe(true);
  });

  await step("after returning to desktop, Today restores the original grid position with both meeting sources intact", async () => {
    await user.resizeViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
    await user.click({ role: "button", label: "Today" });
    await user.see({ role: "button", label: /^Launch standup, Google Calendar/ });
    await user.see({ role: "button", label: /^Partner pipeline review, Outlook Calendar/ });
    const grid = (await element('[data-calendar-grid="week"]')).rect;
    const page = await probe.dom("[data-calendar-page]");
    const ok = Math.abs(grid.top - originalTop) <= 1 && page.documentWidth <= page.viewportWidth;
    evidence.recordAssertionEvidence("phone editing does not leave desktop rows shifted or meetings hidden", `original grid ${originalTop}px → Today grid ${grid.top}px; Google and Outlook visible; document ${page.documentWidth}px / viewport ${page.viewportWidth}px`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
});
