import { spec } from "@openwork/testkit";
import { desktopAutomationOnDenMonitor } from "../worlds/automations.ts";

/**
 * CORE JOURNEY: Den's "My Automations" is a monitor, not an authoring surface.
 * The creating surface owns immutable execution placement — Desktop creates
 * Desktop work and OpenWork Web creates Cloud work — so Den shows what is
 * scheduled and running, links each Automation to the surface that manages
 * it, and keeps exactly one operational control: cancelling an in-flight run.
 */

const test = spec.world(desktopAutomationOnDenMonitor, {
  needs: { optIn: ["OPENWORK_EVAL_AUTOMATIONS_E2E_TEST"] },
  timeout: 420_000,
});

test("Den lists Automations as a read-only monitor that routes management to Web and Desktop", async ({ world, user, step, evidence }) => {
  await step("inspect the Den Automation monitor", async () => {
    await user.see({ text: "My Automations" }, { timeoutMs: 60_000 });
    await user.see({ text: world.name }, { timeoutMs: 60_000 });
    // The routing copy is one clause of the page intro, so match within it.
    await user.see({ text: /Create and edit Cloud Automations in OpenWork Web/ });
    await user.see({ text: "Open in OpenWork Web" });
    // The group heading renders with CSS uppercase, which innerText reflects.
    await user.see({ text: /^scheduled$/i });
    await user.notSee({ text: /New Automation/ });
    evidence.recordAssertionEvidence(
      "Den monitor has no authoring entry",
      "The Den Automations page lists Den-scheduled work grouped by attention and routes creation to OpenWork Web instead of offering its own form.",
      true,
    );
  });

  await step("inspect the Desktop Automation detail", async () => {
    // The card is a button whose text is the whole summary; its title is the exact-text target.
    await user.click({ text: world.name });
    await user.see({ text: "Run receipt" }, { timeoutMs: 30_000 });
    await user.see({ text: "Manage in OpenWork Desktop" });
    // No run is in flight, so the only operational control stays hidden too.
    for (const forbidden of ["Edit", "Deactivate", "Activate", "Run now", "Archive", "Save revision", "Create in Cloud", "Cancel run"]) {
      await user.notSee({ role: "button", text: forbidden });
    }
    evidence.recordAssertionEvidence(
      "Den detail is read-only apart from cancelling an in-flight run",
      "A Desktop-placed Automation shows its schedule, receipts, and a Desktop management pointer without any edit, state, run-now, or archive control.",
      true,
    );

    await user.looks([
      "An Automation detail page with run history and a run receipt panel",
      "A note that the Automation is managed in OpenWork Desktop",
      "No Edit, Run now, Activate, Deactivate, or Archive buttons are visible",
    ]);
  });
});
