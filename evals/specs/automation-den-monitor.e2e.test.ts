import { expect } from "vitest";
import { screenshot, validate } from "@openwork/test-evidence";
import { clickText, createDesktopAutomation, enabledButtons, signInInBrowser, visibleText, waitForText } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { needs, server, test } from "@openwork/testkit";

/**
 * CORE JOURNEY: Den's "My Automations" is a monitor, not an authoring surface.
 * The creating surface owns immutable execution placement — Desktop creates
 * Desktop work and OpenWork Web creates Cloud work — so Den shows what is
 * scheduled and running, links each Automation to the surface that manages
 * it, and keeps exactly one operational control: cancelling an in-flight run.
 */

test("Den lists Automations as a read-only monitor that routes management to Web and Desktop", async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS", "OPENWORK_EVAL_AUTOMATIONS_E2E_TEST"] });
  await using den = await server({ place });

  // A published Desktop client still creates through the legacy route with the free starter model.
  const name = "Monitor placement";
  await createDesktopAutomation(den.admin, {
    name,
    instructions: "Desktop-created Automation visible to the Den monitor.",
    schedule: { kind: "daily", timezone: "UTC", hour: 23, minute: 59 },
  });

  await using browser = await chrome({
    name: "automation-den-monitor",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await signInInBrowser(browser, den.ref.webUrl, { email: den.admin.email, password: den.admin.password });
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/automations`);
  await waitForText(browser, "My Automations", { timeoutMs: 60_000 });
  await waitForText(browser, name, { timeoutMs: 60_000 });

  const listCopy = await visibleText(browser);
  expect(listCopy).toContain("Create and edit Cloud Automations in OpenWork Web");
  expect(listCopy).toContain("Open in OpenWork Web");
  // The group heading renders with CSS uppercase, which innerText reflects.
  expect(listCopy).toMatch(/scheduled/i);
  expect(listCopy).not.toContain("New Automation");
  evidence.recordAssertionEvidence(
    "Den monitor has no authoring entry",
    "The Den Automations page lists Den-scheduled work grouped by attention and routes creation to OpenWork Web instead of offering its own form.",
    true,
  );

  await clickText(browser, name, { selector: "button" });
  await waitForText(browser, "Run receipt", { timeoutMs: 30_000 });
  const detailCopy = await visibleText(browser);
  expect(detailCopy).toContain("Manage in OpenWork Desktop");
  const buttons = await enabledButtons(browser);
  for (const forbidden of ["Edit", "Deactivate", "Activate", "Run now", "Archive", "Save revision", "Create in Cloud"]) {
    expect(buttons.includes(forbidden), `unexpected ${forbidden} control on the Den monitor`).toBe(false);
  }
  // No run is in flight, so the only operational control stays hidden too.
  expect(buttons.includes("Cancel run")).toBe(false);
  evidence.recordAssertionEvidence(
    "Den detail is read-only apart from cancelling an in-flight run",
    "A Desktop-placed Automation shows its schedule, receipts, and a Desktop management pointer without any edit, state, run-now, or archive control.",
    true,
  );

  const shot = await screenshot(browser);
  const seen = await validate(shot, [
    "An Automation detail page with run history and a run receipt panel",
    "A note that the Automation is managed in OpenWork Desktop",
    "No Edit, Run now, Activate, Deactivate, or Archive buttons are visible",
  ]);
  expect(seen.ok, seen.why).toBe(true);
});
