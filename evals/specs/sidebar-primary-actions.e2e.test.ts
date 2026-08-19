import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "the sidebar offers New task and Notifications as primary actions, and the bell is not duplicated in the session header"
  : "sidebar primary actions skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

/** Labels of the top-level rows, which all live in the sidebar header block. */
const primaryActionLabels = `(() => {
  const header = document.querySelector('[data-slot="sidebar-header"]');
  if (!header) return null;
  return [...header.querySelectorAll("button")]
    .map((button) => (button.textContent ?? "").replace(/\\s+/g, " ").trim())
    .filter((label) => label.length > 0);
})()`;

/**
 * The bell used to sit in the session header too. Counting every notifications
 * control on the page proves it moved rather than merely being added.
 */
const notificationControls = `(() => {
  const sidebar = document.querySelector('[data-sidebar="sidebar"]');
  const all = [...document.querySelectorAll("button")]
    .filter((button) => (button.getAttribute("aria-label") ?? "").startsWith("Notifications"));
  return {
    total: all.length,
    inSidebar: all.filter((button) => Boolean(sidebar && sidebar.contains(button))).length,
  };
})()`;

function labels(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error(`Sidebar header rows were not readable: ${JSON.stringify(value)}`);
  return value.map((entry) => (typeof entry === "string" ? entry : ""));
}

function counts(value: unknown): { total: number; inSidebar: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Notification control counts were not an object: ${JSON.stringify(value)}`);
  }
  const total = Reflect.get(value, "total");
  const inSidebar = Reflect.get(value, "inSidebar");
  if (typeof total !== "number" || typeof inSidebar !== "number") {
    throw new Error(`Notification control counts were not numbers: ${JSON.stringify(value)}`);
  }
  return { total, inSidebar };
}

function sessionCount(value: unknown): number {
  if (!Array.isArray(value)) throw new Error(`session.list_sessions did not return a list: ${JSON.stringify(value)}`);
  return value.length;
}

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "sidebar-primary-actions" });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-sidebar-primary-actions-${Date.now()}`,
  });

  await waitFor(app, `Boolean(document.querySelector('[data-slot="sidebar-header"] [data-sidebar-new-chat]'))`, {
    timeoutMs: 60_000,
    label: "sidebar New task row",
  });

  const rows = labels(await evalIn(app, primaryActionLabels));
  for (const expected of ["New task", "Library", "Notifications"]) {
    expect(rows.some((row) => row.includes(expected)), `sidebar header rows: ${JSON.stringify(rows)}`).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "New task and Notifications are top-level sidebar rows alongside search and Library",
    `The sidebar header renders these rows: ${JSON.stringify(rows)}.`,
    true,
  );

  const bells = counts(await evalIn(app, notificationControls));
  expect(bells.total).toBe(1);
  expect(bells.inSidebar).toBe(1);
  evidence.recordAssertionEvidence(
    "The notification bell lives only in the sidebar, not duplicated in the session header",
    `Exactly ${bells.total} notifications control exists on the page and ${bells.inSidebar} of them is inside the sidebar.`,
    true,
  );

  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The sidebar lists New task, Search sessions, Library and Notifications as rows above the workspaces section",
      "No notification bell icon is visible in the header bar above the conversation area",
      "No error dialog or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const before = sessionCount(await control(app, "session.list_sessions"));
  await evalIn(app, `document.querySelector('[data-sidebar-new-chat]')?.click()`);
  await waitFor(app, `window.location.hash.includes("/session/ses_")`, {
    timeoutMs: 60_000,
    label: "session created from the sidebar New task row",
  });
  const after = sessionCount(await control(app, "session.list_sessions"));
  expect(after).toBeGreaterThan(before);
  evidence.recordAssertionEvidence(
    "Clicking the sidebar New task row starts a new session",
    `Sessions went from ${before} to ${after} after clicking the New task row, and the route moved to the new session.`,
    true,
  );

  await evalIn(app, `(() => {
    const sidebar = document.querySelector('[data-sidebar="sidebar"]');
    const bell = [...(sidebar?.querySelectorAll("button") ?? [])]
      .find((button) => (button.getAttribute("aria-label") ?? "").startsWith("Notifications"));
    bell?.click();
  })()`);
  await waitFor(app, `document.body.innerText.includes("No notifications yet")
    || Boolean(document.querySelector('[role="dialog"], [data-popup-open]'))`, {
    timeoutMs: 30_000,
    label: "notification panel opened from the sidebar row",
  });
  evidence.recordAssertionEvidence(
    "The sidebar Notifications row opens the notification panel",
    "Clicking the sidebar notifications control revealed the notification panel.",
    true,
  );

  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The notification panel is open beside the sidebar and reports that there are no notifications yet",
      "No error dialog or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
});
