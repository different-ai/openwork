import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { automationScheduleTriggersWorld } from "../worlds/automation-schedule-triggers.ts";

const test = spec.world(automationScheduleTriggersWorld, { timeout: 600_000, resources: { surfaces: ["appWeb"], services: ["den"] } });
const WITHIN = 60_000;

test("a member schedules an Automation every few hours, or around their meetings, with no feature flag to turn on", async ({ world, user, probe, step, evidence }) => {
  /** The choice a schedule menu shows. */
  const fieldText = async (selector: string) => (await probe.dom(`${selector} [data-slot="select-value"]`)).elements.map((element) => element.text.trim()).join(", ");
  async function openNewAutomation() {
    await user.see({ text: "What do you need done?" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Automations" });
    await user.click({ role: "button", label: "New Automation" });
    await user.see({ label: "Schedule" }, { timeoutMs: WITHIN });
  }
  /** Opens the Schedule menu and reads its choices; leaves it open. */
  async function scheduleChoices(expected?: string) {
    await user.click({ label: "Schedule" });
    await user.see({ role: "option", label: "Once" }, { timeoutMs: WITHIN });
    return probe.eventually(async () => (await probe.dom('[role="option"]')).elements.map((element) => element.text.trim()), {
      within: WITHIN, label: expected ? `the Schedule menu offers ${expected}` : "the Schedule menu lists its choices",
      until: (values) => expected ? values.includes(expected) : values.length > 0,
    });
  }
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  // The schedule-trigger flags are retired (GA): every kind is offered with no /admin step.
  void world;

  await step("the Schedule menu offers Once, Daily, Weekly, Every few hours and Around my meetings", async () => {
    await openNewAutomation();
    const choices = await scheduleChoices("Every few hours");
    evidence.recordAssertionEvidence("Every few hours and Around my meetings are offered by default", choices.join(", "), choices.includes("Every few hours") && choices.includes("Around my meetings"));
    expect(choices).toEqual(["Once", "Daily", "Weekly", "Every few hours", "Around my meetings"]);
    await user.press("Escape");
    await user.screenshot();
  });

  await step("the member picks Every few hours and sets 3 hours, 09:00 to 18:00", async () => {
    await openNewAutomation();
    await scheduleChoices("Every few hours");
    await user.click({ role: "option", label: "Every few hours" });
    await user.see({ label: "Every" }, { timeoutMs: WITHIN });
    await user.see({ label: "From" });
    await user.see({ label: "Until" });
    const values = [await fieldText("#automation-every-hours"), await fieldText("#automation-window-start"), await fieldText("#automation-window-end")];
    evidence.recordAssertionEvidence("Every 3 hours from 09:00 until 18:00 is the starting choice", values.join(", "), values.join(",") === "3 hours,09:00,18:00");
    expect(values).toEqual(["3 hours", "09:00", "18:00"]);
    await user.screenshot();
  });

  await step("the member picks Around my meetings, 5 minutes after each ends", async () => {
    await user.reload();
    await openNewAutomation();
    await scheduleChoices("Around my meetings");
    await user.click({ role: "option", label: "Around my meetings" });
    await user.see({ label: "Runs" }, { timeoutMs: WITHIN });
    await user.see({ label: "Only meetings with people outside my organization" });
    const moment = await fieldText("#automation-meeting-moment");
    evidence.recordAssertionEvidence("5 minutes after each meeting ends is the starting choice", moment, moment === "5 min after it ends");
    expect(moment).toBe("5 min after it ends");
    await user.screenshot();
  });
});
