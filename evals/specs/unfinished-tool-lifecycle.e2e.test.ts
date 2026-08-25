import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "unfinished current-turn tools expose active, waiting, and interrupted outcomes"
  : "unfinished tool lifecycle skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

function lifecycleExpression(lifecycle: "running" | "waiting" | "interrupted", text: string): string {
  return `(() => {
    const rows = Array.from(document.querySelectorAll('[data-tool-lifecycle="${lifecycle}"]'));
    return rows.some((row) => (row.textContent || '').includes(${JSON.stringify(text)}));
  })()`;
}

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "unfinished-tool-lifecycle" });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-unfinished-tool-lifecycle-${Date.now()}`,
  });
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`,
    { timeoutMs: 30_000, label: "new task control ready" },
  );
  let taskCreated = false;
  let createTaskError: unknown = null;
  for (let attempt = 0; attempt < 4 && !taskCreated; attempt += 1) {
    try {
      await control(app, "session.create_task");
      taskCreated = true;
    } catch (error) {
      createTaskError = error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  if (!taskCreated) throw createTaskError;
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "eval.session_lifecycle.seed_unfinished_tools" && !action.disabled)`,
    { timeoutMs: 30_000, label: "unfinished tool lifecycle control ready" },
  );

  await control(app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "active" });
  await waitFor(app, lifecycleExpression("running", "Running 1 command, reading 1 file"), {
    timeoutMs: 15_000,
    label: "active unfinished tools visibly running",
  });
  evidence.recordAssertionEvidence(
    "Active unfinished tools remain visibly in progress",
    "The current-turn command and file read rendered with data-tool-lifecycle=running and a present-tense summary.",
    true,
  );

  await control(app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "waiting" });
  await waitFor(app, lifecycleExpression("waiting", "Waiting for your action"), {
    timeoutMs: 15_000,
    label: "unfinished tools visibly waiting for action",
  });
  expect(await evalIn(app, `document.body.innerText.includes("Choose an option or approve the request to continue.")`)).toBe(true);
  evidence.recordAssertionEvidence(
    "A blocked unfinished step says what it needs",
    "The same tool group changed to data-tool-lifecycle=waiting and displayed an explicit instruction to choose or approve; it no longer used the running lifecycle.",
    true,
  );

  await control(app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "idle" });
  await waitFor(app, lifecycleExpression("interrupted", "Task interrupted"), {
    timeoutMs: 15_000,
    label: "idle unfinished tools visibly interrupted",
  });
  const terminalState = await evalIn(app, `(() => ({
    interrupted: document.body.innerText.includes("This step stopped before it finished. Retry to continue."),
    running: Boolean(document.querySelector('[data-tool-lifecycle="running"]')),
    waiting: Boolean(document.querySelector('[data-tool-lifecycle="waiting"]')),
  }))()`);
  expect(terminalState).toEqual({ interrupted: true, running: false, waiting: false });
  evidence.recordAssertionEvidence(
    "An idle task never leaves its unfinished current step silently running",
    "The tool group converged to data-tool-lifecycle=interrupted, showed retry guidance, and exposed neither running nor waiting lifecycle rows.",
    true,
  );
});
