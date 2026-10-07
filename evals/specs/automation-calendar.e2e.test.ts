import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { automationCalendar } from "../worlds/automation-calendar.ts";

const test = spec.world(automationCalendar, {
  timeout: 600_000,
  // The Calendar is a desktop sidebar destination, and this journey uses the desktop's signed-in Den session and
  // Automation runner identity, as preview-workbot -- --calendar does.
  resources: { surfaces: ["desktop"], services: ["den", "mock"], nativeReason: "The Calendar is a desktop destination over the signed-in member's Den Automations and native calendar connections." },
  needs: { commands: ["pnpm"], optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
});

test("an owner sees their Automations next to Google and Outlook meetings, pauses one, and sees a calendar sign-in lapse as a lock", async ({ world, user, probe, step, evidence }) => {
  const alex = user.on(world.desktop);
  const look = probe.on(world.desktop);
  const blocks = async (selector: string) => (await look.dom(selector)).elements.length;

  await step("Alex opens Calendar and sees this week's Automations next to Google and Outlook meetings", async () => {
    await alex.click({ role: "button", label: "Calendar" });
    await alex.see({ role: "button", label: /^Launch standup, Google Calendar/ }, { timeoutMs: 60_000 });
    await alex.see({ role: "button", label: /^Partner pipeline review, Outlook/ });
    await alex.see({ role: "button", label: /^Weekly launch update, / });
    const automations = await blocks("[data-calendar-automation]");
    const google = await blocks('[data-calendar-provider="google"]');
    const outlook = await blocks('[data-calendar-provider="microsoft"]');
    const upstream = world.calendarRequests();
    evidence.recordAssertionEvidence("one week, both layers", `${automations} Automation blocks, ${google} Google meetings, ${outlook} Outlook meetings; ${upstream} provider reads went through Den`, automations >= 5 && google >= 5 && outlook >= 2 && upstream >= 2);
    expect(automations).toBeGreaterThanOrEqual(5);
    expect(google).toBeGreaterThanOrEqual(5);
    expect(outlook).toBeGreaterThanOrEqual(2);
    expect(upstream).toBeGreaterThanOrEqual(2);
    await alex.screenshot();
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
    await alex.click({ role: "button", label: "Next" });
    await alex.click({ role: "button", label: /^Update launch deals, Blocked until fixed/ });
    await alex.see({ text: "Needs attention" });
    await alex.see({ text: /Needs HubSpot access/ });
    const blocked = await blocks('[data-calendar-status="blocked"]');
    const panel = await look.dom("[data-calendar-next-run]");
    const nextRun = panel.elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("blocked slot is nominal", `${blocked} locked slot(s); panel says "${nextRun}"`, blocked >= 1 && nextRun === "Not scheduled until fixed");
    expect(nextRun).toBe("Not scheduled until fixed");
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

  await step("after: when Google sign-in expires, Google meetings show a reconnect lock and Outlook meetings stay", async () => {
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
