import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { accountDiagnostics } from "../worlds/account-diagnostics.ts";

const test = spec.world(accountDiagnostics, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
  needs: { commands: ["bun"] },
});

const SECTION = "#advanced-agent-access";

test("a member whose connected tools stopped working sees what is wrong and copies one report to share", async ({ world, user, probe, step, evidence }) => {
  /** The status lines, as the member reads them. */
  const status = async () => (await probe.dom('[data-testid="diagnostics-summary"]')).elements[0]?.text.replace(/\s+/g, " ").trim() ?? "";
  const technicalDetails = async () => ({
    all: (await probe.dom(`${SECTION} details`)).elements.length,
    open: (await probe.dom(`${SECTION} details[open]`)).elements.length,
  });
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

  await step("given: the member's connection is off, so the account menu offers Run diagnostics", async () => {
    await user.click({ testId: "account-status-menu" });
    await user.see({ role: "menuitem", label: "Run diagnostics" }, { timeoutMs: 30_000 });
    await user.screenshot();
  });

  await step("after: Run diagnostics shows one status line, the versions and a Copy report button", async () => {
    await user.click({ role: "menuitem", label: "Run diagnostics" });
    await user.see({ role: "button", label: "Copy report" }, { timeoutMs: 30_000 });
    // The check starts without another click and ends on a result, not a spinner.
    const line = await probe.eventually(status, {
      within: 60_000, label: "the check finishes without another click",
      until: text => text.startsWith("Turned off") || text.startsWith("Needs attention"),
    });
    const details = await technicalDetails();
    await user.notSee({ role: "button", label: "Copy sanitized diagnostic" });
    const short = details.all > 0 && details.open === 0;
    evidence.recordAssertionEvidence(
      "The state is one plain line and the technical rows stay closed",
      `status reads: ${line}; technical details open: ${details.open} of ${details.all}`,
      short,
    );
    await user.screenshot();
    expect(short, "the technical rows are present but closed").toBe(true);
  });

  await step("after: Copy report puts the full report on the clipboard in one click", async () => {
    await user.click({ role: "button", label: "Copy report" });
    await user.see({ text: "Diagnostics copied" }, { timeoutMs: 30_000 });
    const copied = await probe.eventually(() => world.readClipboard(), {
      within: 15_000, label: "the report reached the clipboard", until: value => value.includes('"capturedAt"'),
    });
    const report: unknown = JSON.parse(copied);
    const has = (key: string) => typeof report === "object" && report !== null && Reflect.get(report, key) != null;
    // Witness: the copied text is the whole report, including the check shown on screen.
    const whole = has("capturedAt") && has("openworkServer") && has("cloudMcp") && has("developerLogs");
    evidence.recordAssertionEvidence(
      "One click copies the whole report, with the result of the check in it",
      `clipboard: ${copied.length} characters of JSON; has the capture time, server state, connected-tools check and recent logs: ${whole}`,
      whole,
    );
    await user.screenshot();
    expect(whole, "the copied report carries the connected-tools check and recent logs").toBe(true);
  });

  await step("the technical rows open with one click for whoever is helping", async () => {
    await user.click({ text: "Technical details" });
    await user.see({ text: "Desired revision" });
    const details = await technicalDetails();
    evidence.recordAssertionEvidence(
      "The exact runtime state is still one click away",
      `technical details open: ${details.open} of ${details.all}; "Desired revision" row visible`,
      details.open === 1,
    );
    await user.screenshot();
    expect(details.open).toBe(1);
  });
});
