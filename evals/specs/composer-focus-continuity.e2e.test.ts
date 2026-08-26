import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "same-session refresh preserves composer focus and uninterrupted typing"
  : "composer focus continuity skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "composer-focus-continuity" });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-composer-focus-continuity-${Date.now()}`,
  });
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`,
    { timeoutMs: 30_000, label: "new task control ready" },
  );
  await control(app, "session.create_task");
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "eval.composer_focus.refresh_current_session" && !action.disabled)`,
    { timeoutMs: 30_000, label: "composer refresh proof control ready" },
  );
  await waitFor(
    app,
    `Boolean(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]'))`,
    { timeoutMs: 30_000, label: "composer editor ready" },
  );

  const firstDraft = "Keep this draft while the task finishes";
  const suffix = " and let me keep typing.";
  const focused = await evalIn(app, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    return document.activeElement === editor;
  })()`);
  expect(focused).toBe(true);
  await app.client.send("Input.insertText", { text: firstDraft });
  await waitFor(
    app,
    `(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')?.innerText ?? "").trim() === ${JSON.stringify(firstDraft)}`,
    { timeoutMs: 10_000, label: "initial composer draft" },
  );

  const refresh = await control(app, "eval.composer_focus.refresh_current_session");
  expect(refresh).toMatchObject({
    ok: true,
    wasFocused: true,
    remainsFocused: true,
    editable: true,
  });

  const stateAfterRefresh = await evalIn(app, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    return {
      focused: editor instanceof HTMLElement && document.activeElement === editor,
      editable: editor?.getAttribute('contenteditable') === 'true',
      text: editor instanceof HTMLElement ? editor.innerText.trim() : '',
    };
  })()`);
  expect(stateAfterRefresh).toEqual({
    focused: true,
    editable: true,
    text: firstDraft,
  });
  evidence.recordAssertionEvidence(
    "A same-session completion refresh preserves composer focus and editability",
    "The active Lexical editor remained focused and contenteditable after its session snapshot refreshed.",
    true,
  );

  await app.client.send("Input.insertText", { text: suffix });
  await waitFor(
    app,
    `(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')?.innerText ?? "").trim() === ${JSON.stringify(firstDraft + suffix)}`,
    { timeoutMs: 10_000, label: "continued composer draft" },
  );
  evidence.recordAssertionEvidence(
    "The existing draft remains intact and typing continues without another click",
    `The composer preserved “${firstDraft}” and accepted the suffix immediately after refresh.`,
    true,
  );
});
