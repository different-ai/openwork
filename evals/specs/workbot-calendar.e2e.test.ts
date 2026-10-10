import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotCalendar } from "../worlds/workbot-calendar.ts";

const test = spec.world(workbotCalendar, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { placement: "local", optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
  timeout: 900_000,
});

test("a Workbot member sees their Automations next to Google and Outlook meetings and pauses one, behind Workbot's own Calendar switch", async ({ world, user, probe, step, evidence }) => {
  const count = async (selector: string) => (await probe.dom(selector)).elements.length;

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

  await step("Alex clicks an empty Wednesday slot next week and creates a cloud Automation that repeats there", async () => {
    await user.click({ role: "button", label: /^New automation on Wed, .* at 12:30 PM$/ });
    await user.see({ text: /Runs on .*'s cloud computer\./ });
    await user.type({ role: "textbox", label: /^What should .* do\?$/ }, "Check the launch checklist for anything still open");
    await user.click({ role: "radio", label: "Wednesdays" });
    await user.click({ role: "button", text: "Create automation" });
    await user.see({ text: "Automation created" });
    await user.see({ text: /^Every Wednesday at 12:30 PM/ });
    await user.see({ role: "button", label: /^Check the launch checklist for anything still open, Scheduled/ });
    const created = await count('[data-calendar-automation][aria-label^="Check the launch checklist"]');
    evidence.recordAssertionEvidence("created through Workbot and Den", `${created} new slot(s) on next week's grid; the panel shows "Every Wednesday at 12:30 PM"`, created >= 1);
    expect(created).toBeGreaterThanOrEqual(1);
    await user.screenshot();
  });

  await step("Alex edits it: new instructions and another model, picked from a list with provider logos; it stays in the cloud", async () => {
    await user.click({ role: "button", text: "Edit" });
    await user.see({ text: "Cloud: Only connected accounts" });
    await user.type({ role: "textbox", label: "Instructions" }, "Check the launch checklist and list owners of anything still open", { replace: true });
    await user.click({ role: "button", label: "Model" });
    const options = (await probe.dom('[role="listbox"] [role="option"]')).elements.map((element) => element.text);
    // Provider logos: inline marks (svg role=img) or remote images, one per vendor model.
    const logos = await count('[role="listbox"] [role="option"] img, [role="listbox"] [role="option"] svg[role="img"]');
    const next = options.find((text) => !/Cloud default/.test(text)) ?? options[0] ?? "";
    await user.click({ role: "option", label: new RegExp(`^${next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
    await user.click({ role: "button", text: "Save changes" });
    await user.see({ text: "Automation updated" });
    await user.see({ text: "Check the launch checklist and list owners of anything still open" });
    const model = (await probe.dom("[data-calendar-detail] [data-automation-model]")).elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("edited through Workbot and Den", `${options.length} models offered with ${logos} logos; picked "${next}", the panel now shows "${model}"`, options.length >= 1 && logos >= 1 && model.startsWith(next));
    expect(options.length).toBeGreaterThanOrEqual(1);
    expect(logos).toBeGreaterThanOrEqual(1);
    expect(model.startsWith(next)).toBe(true);
    await user.screenshot();
  });

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
