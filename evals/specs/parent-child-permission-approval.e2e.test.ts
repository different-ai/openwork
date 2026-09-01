import { expect } from "vitest";
import {
  clickButton,
  control,
  createAndSelectWorkspace,
  evalIn,
  waitFor,
} from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { screenshot } from "@openwork/test-evidence";
import { needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "a parent task surfaces and resolves its child session permission request"
  : "parent child permission approval skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "parent-child-permission-approval" });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-parent-child-permission-${Date.now()}`,
  });
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`,
    { timeoutMs: 30_000, label: "new task control ready" },
  );
  await control(app, "session.create_task");
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "eval.task_activity.seed" && !action.disabled) && window.__openworkControl.listActions().some((action) => action.id === "eval.child_permission.seed" && !action.disabled)`,
    { timeoutMs: 30_000, label: "child permission proof control ready" },
  );
  const seeded = await control(app, "eval.child_permission.seed");
  if (!isRecord(seeded) || typeof seeded.childSessionId !== "string") {
    throw new Error(`The child permission seed returned an unexpected result: ${JSON.stringify(seeded)}`);
  }
  await control(app, "eval.task_activity.seed", { childSessionId: seeded.childSessionId });

  await waitFor(
    app,
    `Boolean(document.querySelector('[data-subagent-permission="pending"] [data-subagent-permission-icon]')) && Boolean(document.querySelector('[data-permission-source="child-session"]'))`,
    { timeoutMs: 15_000, label: "parent-visible child permission request" },
  );

  const waiting = await evalIn(app, `(() => {
    const row = document.querySelector('[data-subagent-permission="pending"]');
    const source = document.querySelector('[data-permission-source="child-session"]');
    const buttons = [...document.querySelectorAll('button')]
      .map((button) => (button.textContent ?? '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean);
    return {
      rowText: row instanceof HTMLElement ? row.innerText.replace(/\\s+/g, ' ').trim() : '',
      sourceText: source instanceof HTMLElement ? source.innerText.replace(/\\s+/g, ' ').trim() : '',
      activity: row instanceof HTMLElement ? row.dataset.subagentActivity ?? '' : '',
      childSessionId: row instanceof HTMLElement ? row.dataset.subagentSessionId ?? '' : '',
      hasPermissionIcon: Boolean(row?.querySelector('[data-subagent-permission-icon]')),
      hasShimmer: Boolean(row?.querySelector('.ow-text-shimmer')),
      buttons,
      pageText: (document.body.innerText ?? '').replace(/\\s+/g, ' '),
    };
  })()`);

  expect(waiting).toMatchObject({
    activity: "waiting-permission",
    hasPermissionIcon: true,
    hasShimmer: false,
  });
  if (!isRecord(waiting)) {
    throw new Error(`The parent-visible permission state was unreadable: ${JSON.stringify(waiting)}`);
  }
  expect(waiting.rowText).toContain("Needs permission");
  expect(waiting.sourceText).toBe("Requested by Investigate the deployment failure");
  expect(waiting.childSessionId).toContain(":eval-child");
  expect(waiting.buttons).toEqual(expect.arrayContaining(["Deny", "Allow once", "Allow for session"]));
  expect(waiting.pageText).toContain("git status --short --branch");
  evidence.recordAssertionEvidence(
    "The parent identifies the blocked child without making the user open its session",
    `The delegated-task row showed a shield and “${String(waiting.rowText)}”, while the parent approval panel named “${String(waiting.sourceText)}”.`,
    true,
  );
  evidence.recordAssertionEvidence(
    "The parent exposes the child request and all decision controls",
    "The approval panel showed the requested shell scope with Deny, Allow once, and Allow for session enabled.",
    true,
  );
  await screenshot(app);

  await clickButton(app, "Allow once");
  await waitFor(
    app,
    `!document.querySelector('[data-permission-source="child-session"]') && !document.querySelector('[data-subagent-permission="pending"]') && Boolean(document.querySelector('[data-subagent-activity="shimmer"] .ow-text-shimmer'))`,
    { timeoutMs: 15_000, label: "child permission resolved from parent" },
  );

  const resolved = await evalIn(app, `({
    permissionPanelVisible: Boolean(document.querySelector('[data-permission-source="child-session"]')),
    waitingIconVisible: Boolean(document.querySelector('[data-subagent-permission="pending"]')),
    runningTreatmentVisible: Boolean(document.querySelector('[data-subagent-activity="shimmer"] .ow-text-shimmer')),
  })`);
  expect(resolved).toEqual({
    permissionPanelVisible: false,
    waitingIconVisible: false,
    runningTreatmentVisible: true,
  });
  evidence.recordAssertionEvidence(
    "Approving from the parent clears the child's blocked state",
    "After Allow once, the parent approval panel and child shield both disappeared, and the same child row returned to its running treatment.",
    true,
  );
});
