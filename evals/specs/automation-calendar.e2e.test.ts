import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { automationCalendar, automationCalendarSetup } from "../worlds/automation-calendar.ts";

type Bounds = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const fitsCard = (rect: Bounds, width: number, height: number) => rect.left >= 11 && rect.right <= width - 11 && rect.top >= 11 && rect.bottom <= height - 11;

const test = spec.world(automationCalendar, {
  timeout: 600_000,
  // The Calendar is a desktop sidebar destination, and this journey uses the desktop's signed-in Den session and
  // Automation runner identity, as preview-workbot -- --calendar does.
  resources: { surfaces: ["desktop"], services: ["den", "mock"], nativeReason: "The Calendar is a desktop destination over the signed-in member's Den Automations and native calendar connections." },
  needs: { placement: "local", commands: ["pnpm"], optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
});

test("an owner sees their Automations next to Google and Outlook meetings, pauses one, and gets a reconnect action when calendar sign-in expires", async ({ world, user, probe, step, evidence }) => {
  const alex = user.on(world.desktop);
  const look = probe.on(world.desktop);
  const blocks = async (selector: string) => (await look.dom(selector)).elements.length;
  const element = async (selector: string) => {
    const first = (await look.dom(selector)).elements[0];
    if (!first) throw new Error(`Missing Calendar element: ${selector}`);
    return first;
  };
  let originalTop = 0;
  let originalToolbarHeight = 0;

  await step("Alex opens Calendar and sees this week's Automations next to Google and Outlook meetings", async () => {
    await alex.resizeViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
    await alex.click({ role: "button", label: "Calendar" });
    // Only read the loaded DOM here: user.see on a meeting can scroll the grid before we witness first load.
    await look.eventually(async () => (await blocks("[data-calendar-hour]")) === 24 && (await blocks("[data-calendar-automation]")) >= 5 && (await blocks('[data-calendar-provider="google"]')) >= 5 && (await blocks('[data-calendar-provider="microsoft"]')) >= 2, { within: 60_000, label: "both Calendar layers are loaded without scrolling to an event", until: Boolean });
    const rail = await world.hourRail();
    const initial = await look.eventually(() => world.hourRailLayout(), { within: 5_000, label: "the initial Calendar scroll has reached the morning hours", until: (layout) => layout.firstHour.text === "7 AM" });
    const firstHourFits = initial.firstHour.rect.top >= initial.scroller.top && initial.firstHour.rect.bottom <= initial.scroller.bottom;
    originalTop = (await element('[data-calendar-grid="week"]')).rect.top;
    originalToolbarHeight = (await element("[data-calendar-toolbar]")).rect.height;
    // Capture the initial rail before any event lookup. Edge clipping after later scrolling is normal.
    await alex.screenshot();
    const automations = await blocks("[data-calendar-automation]");
    const google = await blocks('[data-calendar-provider="google"]');
    const outlook = await blocks('[data-calendar-provider="microsoft"]');
    const upstream = world.calendarRequests();
    const meetingsUsePlainSpacing = (await look.dom("[data-calendar-meeting]")).elements.every((meeting) => !meeting.text.includes("—"));
    evidence.recordAssertionEvidence("one week, both layers and the complete first hour on initial landing", `${automations} Automation blocks, ${google} Google meetings, ${outlook} Outlook meetings; ${upstream} provider reads; hours ${rail.fontSize}px at ${rail.contrast.toFixed(2)}:1; initial ${initial.firstHour.text} at ${initial.firstHour.rect.top.toFixed(1)}–${initial.firstHour.rect.bottom.toFixed(1)}px inside scroller ${initial.scroller.top.toFixed(1)}–${initial.scroller.bottom.toFixed(1)}px; meeting text has no em dash ${meetingsUsePlainSpacing}; grid starts at ${originalTop}px`, automations >= 5 && google >= 5 && outlook >= 2 && upstream >= 2 && rail.contrast >= 4.5 && rail.fontSize >= 12 && firstHourFits && meetingsUsePlainSpacing);
    expect(firstHourFits).toBe(true);
    expect(meetingsUsePlainSpacing).toBe(true);
    expect(rail.contrast).toBeGreaterThanOrEqual(4.5);
    expect(rail.fontSize).toBeGreaterThanOrEqual(12);
    expect(automations).toBeGreaterThanOrEqual(5);
    expect(google).toBeGreaterThanOrEqual(5);
    expect(outlook).toBeGreaterThanOrEqual(2);
    expect(upstream).toBeGreaterThanOrEqual(2);
    await alex.see({ role: "button", label: /^Launch standup, Google Calendar/ }, { timeoutMs: 60_000 });
    await alex.see({ role: "button", label: /^Partner pipeline review, Outlook/ });
    await alex.see({ role: "button", label: /^Weekly launch update, / });
    await alex.screenshot();
  });

  await step("before: meeting provider subtitles share the title's space with Calendar polish off", async () => {
    const meetings = (await look.dom("[data-calendar-meeting]")).elements;
    expect(meetings.some((meeting) => meeting.text.includes("Google Calendar"))).toBe(true);
    expect(await blocks("[data-calendar-provider-logo]")).toBe(0);
    await alex.screenshot();
    evidence.recordAssertionEvidence("The off switch preserves the existing desktop meeting presentation", "Provider names remain visible beside meeting titles; no compact provider logos are rendered.", true);
  });
  await step("after: compact provider logos give desktop meeting titles room without losing their accessible names", async () => {
    await world.setCalendarPolish(true);
    await alex.reload();
    await alex.click({ role: "button", label: "Calendar" });
    await alex.see({ role: "button", label: /^Launch standup, Google Calendar/ }, { timeoutMs: 60_000 });
    await alex.see({ role: "button", label: /^Partner pipeline review, Outlook/ });
    const meetings = (await look.dom("[data-calendar-meeting]")).elements;
    const logos = await blocks("[data-calendar-meeting] [data-calendar-provider-logo]");
    expect(logos).toBe(meetings.length);
    expect(meetings.every((meeting) => !meeting.text.includes("Google Calendar") && !meeting.text.includes("Outlook Calendar"))).toBe(true);
    originalTop = (await element('[data-calendar-grid="week"]')).rect.top;
    originalToolbarHeight = (await element("[data-calendar-toolbar]")).rect.height;
    await alex.screenshot();
    evidence.recordAssertionEvidence("Both providers stay named for assistive technology, not in the title lane", `${logos} meeting logos; Google and Outlook accessible names still locate their original meetings.`, true);
  });

  await step("Alex selects the weekly launch update and sees when it repeats, where it runs and its past runs", async () => {
    await alex.click({ role: "button", label: /^Weekly launch update, / });
    await alex.see({ text: /Every Friday at 3:00 PM/ });
    await alex.see({ text: "OpenWork Cloud. Your computer can be closed." });
    await alex.see({ text: /Completed in \d/ });
    const pastRuns = (await look.dom("[data-calendar-past-runs] li")).elements.length;
    evidence.recordAssertionEvidence("run receipts", `${pastRuns} past runs listed from Den`, pastRuns >= 1);
    expect(pastRuns).toBeGreaterThanOrEqual(1);
    await alex.screenshot();
  });

  await step("next week, an Automation that needs HubSpot shows a lock, never a confirmed upcoming run", async () => {
    // Next week, so the slot is ahead of now whatever day the spec runs.
    const thisWeek = (await look.dom("[data-calendar-range-label]")).elements[0]?.text ?? "";
    await alex.click({ role: "button", label: "Next" });
    // Wait for next week to render, so the click below cannot land on this week's block as it unmounts.
    await look.eventually(async () => (await look.dom("[data-calendar-range-label]")).elements[0]?.text ?? "", { within: 15_000, label: "next week is on screen", until: (text) => text !== "" && text !== thisWeek });
    await alex.click({ role: "button", label: /^Update launch deals, Blocked until fixed/ });
    await alex.see({ text: "Needs attention" });
    await alex.see({ text: /Needs HubSpot access/ });
    await alex.see({ text: world.recovery.hubspotMessage });
    expect((await element("[data-calendar-blocked] [data-calendar-recovery]")).text).toBe(world.recovery.hubspotMessage);
    const blocked = await blocks('[data-calendar-status="blocked"]');
    const panel = await look.dom("[data-calendar-next-run]");
    const nextRun = panel.elements[0]?.text ?? "";
    const nextTop = (await element('[data-calendar-grid="week"]')).rect.top;
    const toolbarHeight = (await element("[data-calendar-toolbar]")).rect.height;
    const stable = Math.abs(nextTop - originalTop) <= 1 && Math.abs(toolbarHeight - originalToolbarHeight) <= 1;
    evidence.recordAssertionEvidence("blocked slots preserve the server's complete next step and week navigation preserves the grid", `${blocked} locked slot(s); "${nextRun}"; unchanged recovery "${world.recovery.hubspotMessage}"; grid ${originalTop}px → ${nextTop}px; toolbar ${originalToolbarHeight}px → ${toolbarHeight}px`, blocked >= 1 && nextRun === "Not scheduled until fixed" && stable);
    expect(nextRun).toBe("Not scheduled until fixed");
    expect(stable).toBe(true);
    await alex.screenshot();
  });

  await step("the owner keeps their own reconnect instruction before retrying a blocked automation", async () => {
    await alex.click({ role: "button", label: /^What's waiting on me, Blocked until fixed/ });
    await alex.see({ text: world.recovery.message });
    const recovery = await element("[data-calendar-blocked] [data-calendar-recovery]");
    const notice = await element("[data-calendar-blocked]");
    const runDisabled = (await look.dom('[data-calendar-detail] button[disabled]')).elements.some((button) => button.text === "Run now");
    const ok = recovery.text === world.recovery.message && !notice.text.includes("Ask your workspace admin") && runDisabled;
    evidence.recordAssertionEvidence("both server sentences remain unchanged without contradictory admin advice", `"${recovery.text}"; invented Ask admin line ${notice.text.includes("Ask your workspace admin")}; Run now disabled ${runDisabled}`, ok);
    expect(ok).toBe(true);
    await alex.screenshot();
  });

  await step("after: pausing the weekly launch update removes its slot next week", async () => {
    await alex.see({ role: "button", label: /^Weekly launch update, Scheduled/ });
    const before = await blocks('[data-calendar-status="upcoming"][aria-label^="Weekly launch update"]');
    await alex.click({ role: "button", label: /^Weekly launch update, Scheduled/ });
    await alex.click({ role: "button", label: "Pause" });
    await alex.see({ text: "Automation paused. A run already in progress will continue." });
    await alex.notSee({ role: "button", label: /^Weekly launch update, Scheduled/ }, { timeoutMs: 15_000 });
    const after = await blocks('[data-calendar-status="upcoming"][aria-label^="Weekly launch update"]');
    evidence.recordAssertionEvidence("paused slots", `upcoming slots next week: ${before} before, ${after} after Pause`, before === 1 && after === 0);
    expect(before).toBe(1);
    expect(after).toBe(0);
    await alex.see({ role: "button", label: "Resume" });
    await alex.screenshot();
  });

  await step("in a narrow desktop window, details sit below the grid and New automation fits with reachable actions", async () => {
    await alex.resizeViewport({ width: 800, height: 700, deviceScaleFactor: 1 });
    await alex.see({ role: "button", label: "New automation" });
    const grid = (await element('[data-calendar-grid="week"]')).rect;
    const detail = (await element("[data-calendar-detail]")).rect;
    const page = await look.dom("[data-calendar-page]");
    await alex.click({ role: "button", label: "New automation" });
    await alex.type({ role: "textbox", label: "What should it do?" }, "Review the launch checklist in the smaller window");
    const form = (await element("[data-calendar-create]")).rect;
    const actions = (await element("[data-calendar-create] [data-calendar-form-actions]")).rect;
    const ok = grid.width >= 250 && detail.top >= grid.bottom - 1 && detail.width <= page.viewportWidth && fitsCard(form, 800, 700) && actions.bottom <= 689 && page.documentWidth <= page.viewportWidth;
    evidence.recordAssertionEvidence("narrow desktop selection leaves room for the grid and the real form", `800×700; grid ${Math.round(grid.width)}px; details below ${Math.round(grid.bottom)}px at ${Math.round(detail.top)}px; form ${Math.round(form.width)}×${Math.round(form.height)}px; footer ${Math.round(actions.bottom)}px; document ${page.documentWidth}px / viewport ${page.viewportWidth}px`, ok);
    expect(ok).toBe(true);
    await alex.screenshot();
  });

  await step("on a short desktop viewport, the open creation form shifts into view and Cancel stays clickable", async () => {
    await alex.resizeViewport({ width: 667, height: 375, deviceScaleFactor: 1 });
    await alex.see({ role: "button", text: "Cancel" });
    const form = (await element("[data-calendar-create]")).rect;
    const actions = (await element("[data-calendar-create] [data-calendar-form-actions]")).rect;
    const page = await look.dom("[data-calendar-create]");
    const bounded = fitsCard(form, 667, 375) && actions.bottom <= 363 && page.documentWidth <= page.viewportWidth;
    await alex.screenshot();
    await alex.click({ role: "button", text: "Cancel" });
    await alex.notSee({ role: "textbox", label: "What should it do?" });
    const closed = (await look.dom("[data-calendar-create]")).elements.length === 0;
    evidence.recordAssertionEvidence("the short creation card keeps its actions within the viewport", `667×375; form top ${Math.round(form.top)}px, bottom ${Math.round(form.bottom)}px; footer ${Math.round(actions.bottom)}px; Cancel dismissed it ${closed}; document ${page.documentWidth}px / viewport ${page.viewportWidth}px`, bounded && closed);
    expect(bounded && closed).toBe(true);
    await alex.resizeViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
  });

  await step("Alex clicks an empty Wednesday slot next week and creates an Automation that repeats there", async () => {
    await alex.click({ role: "button", label: /^New automation on Wed, .* at 12:30 PM$/ });
    await alex.see({ text: /^At 12:30 PM / });
    await alex.see({ text: "Needs OpenWork open on one of your computers at the scheduled time." });
    await alex.type({ role: "textbox", label: /^What should it do\?$/ }, "Check the launch checklist for anything still open");
    await alex.click({ role: "button", text: "Create automation" });
    await alex.see({ text: "Automation created" });
    await alex.see({ text: /^Every Wednesday at 12:30 PM/ });
    await alex.see({ role: "button", label: /^Check the launch checklist for anything still open, / });
    const created = await blocks('[data-calendar-automation][aria-label^="Check the launch checklist"]');
    evidence.recordAssertionEvidence("created from the slot", `${created} new slot(s) on next week's grid; the panel shows "Every Wednesday at 12:30 PM"`, created >= 1);
    expect(created).toBeGreaterThanOrEqual(1);
    await alex.screenshot();
  });

  await step("Alex edits it from the Calendar with the Automations editor: new instructions, its model shown with the provider's logo", async () => {
    await alex.click({ role: "button", text: "Edit" });
    await alex.see({ text: "Edit automation" });
    await alex.resizeViewport({ width: 667, height: 375, deviceScaleFactor: 1 });
    await alex.type({ role: "textbox", label: "Instructions" }, "Check the launch checklist and list owners of anything still open", { replace: true });
    await alex.see({ role: "button", text: "Save changes" });
    const logos = (await look.dom("[data-calendar-edit] [data-automation-model] img, [data-calendar-edit] [data-automation-model] svg[role='img']")).elements.length;
    const dialog = (await element("[data-calendar-edit]")).rect;
    const save = (await element('[data-calendar-edit] button[type="submit"]')).rect;
    const page = await look.dom("[data-calendar-edit]");
    const fits = dialog.left >= 0 && dialog.right <= 667 && dialog.top >= 0 && dialog.bottom <= 375 && save.top >= 0 && save.bottom <= 375 && page.documentWidth <= page.viewportWidth;
    await alex.screenshot();
    await alex.click({ role: "button", text: "Save changes" });
    await alex.see({ text: "Automation updated" });
    await alex.see({ text: "Check the launch checklist and list owners of anything still open" });
    const model = (await look.dom("[data-calendar-detail] [data-automation-model]")).elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("edited through the shared editor with Save changes reachable on a short screen", `667×375; dialog bottom ${Math.round(dialog.bottom)}px, Save changes bottom ${Math.round(save.bottom)}px; model button ${logos} logo(s); saved panel model "${model}"; document ${page.documentWidth}px / viewport ${page.viewportWidth}px`, fits && logos >= 1 && model.length > 0);
    expect(fits).toBe(true);
    expect(logos).toBeGreaterThanOrEqual(1);
    expect(model.length).toBeGreaterThan(0);
    await alex.screenshot();
    await alex.resizeViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
  });

  await step("after: when Google sign-in expires, Google offers Reconnect and Outlook meetings stay", async () => {
    await world.expireGoogleSignIn();
    await alex.reload();
    // Startup reopens the last workspace; Alex goes back to the Calendar.
    await alex.click({ role: "button", label: "Calendar" });
    await alex.see({ text: "Reconnect Google Calendar" }, { timeoutMs: 60_000 });
    await alex.see({ role: "button", label: /, Outlook/ });
    await alex.see({ role: "button", label: /^What's waiting on me, / });
    const google = await blocks('[data-calendar-provider="google"]');
    const automations = await blocks("[data-calendar-automation]");
    evidence.recordAssertionEvidence("one provider failing does not hide the others", `${google} Google meetings, ${automations} Automation blocks still shown`, google === 0 && automations > 0);
    expect(google).toBe(0);
    expect(automations).toBeGreaterThan(0);
    await alex.screenshot();
  });
});

const setupTest = spec.world(automationCalendarSetup, {
  timeout: 600_000,
  resources: { surfaces: ["desktop"], services: ["den", "mock"], nativeReason: "The member opens the desktop Calendar and its existing Library connection route using the desktop's signed-in Den session." },
  needs: { placement: "local", commands: ["pnpm"], optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
});

setupTest("a member's Google Calendar setup shows the provider logo and an honest sign-in action, not a policy lock", async ({ world, user, probe, step, evidence }) => {
  const alex = user.on(world.desktop);
  const look = probe.on(world.desktop);
  const count = async (selector: string) => (await look.dom(selector)).elements.length;

  await step("before sign-in: Google offers Connect with its logo while Outlook meetings remain visible", async () => {
    await alex.resizeViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
    await alex.click({ role: "button", label: "Calendar" });
    await alex.see({ role: "button", text: "Connect Google Calendar" }, { timeoutMs: 60_000 });
    await alex.see({ role: "button", label: /, Outlook/ });
    const logos = await count('[data-calendar-provider-status="google"][data-state="not_connected"] img');
    const locks = await count('[data-calendar-provider-status="google"][data-state="not_connected"] svg');
    const google = await count('[data-calendar-provider="google"]');
    const outlook = await count('[data-calendar-provider="microsoft"]');
    const ok = logos === 1 && locks === 0 && google === 0 && outlook >= 1;
    evidence.recordAssertionEvidence("not signed in is a provider setup state, not a blocked state", `${logos} Google logo, ${locks} lock icons; Connect Google Calendar visible; ${google} Google meetings, ${outlook} Outlook meetings`, ok);
    expect(ok).toBe(true);
    await alex.screenshot();
  });

  await step("the member can reach that same unsigned-in Google account through the existing Library route", async () => {
    await alex.click({ role: "button", label: "Library" });
    await alex.see({ text: "Google Workspace" }, { timeoutMs: 60_000 });
    const status = await look.eventually(async () => (await look.dom('[data-library-row="Google Workspace"] [data-library-status]')).elements[0]?.text ?? "", { within: 30_000, label: "Google's member sign-in state is on screen", until: (text) => text === "Sign in" });
    const route = await look.hash();
    const ok = route.includes("/extensions") && status === "Sign in";
    evidence.recordAssertionEvidence("the connection direction leads to a real member connection surface", `Library route "${route}"; Google Workspace state "${status}"`, ok);
    expect(ok).toBe(true);
    await alex.screenshot();
  });

  await step("after returning to Calendar, setup keeps the meetings and New automation controls intact", async () => {
    await alex.click({ role: "button", label: "Calendar" });
    await alex.see({ role: "button", text: "Connect Google Calendar" });
    await alex.see({ role: "button", label: /, Outlook/ });
    await alex.see({ role: "button", label: "New automation" });
    const page = await look.dom("[data-calendar-page]");
    const wrongCase = (await look.dom("[data-calendar-page] button")).elements.filter((button) => button.text === "New Automation").length;
    const google = await count('[data-calendar-provider="google"]');
    const outlook = await count('[data-calendar-provider="microsoft"]');
    const ok = google === 0 && outlook >= 1 && wrongCase === 0 && page.documentWidth <= page.viewportWidth;
    evidence.recordAssertionEvidence("setup does not hide the other provider or change the creation action's name", `${google} Google meetings, ${outlook} Outlook meetings; ${wrongCase} inconsistent New Automation labels; document ${page.documentWidth}px / viewport ${page.viewportWidth}px`, ok);
    expect(ok).toBe(true);
    await alex.screenshot();
  });
});
