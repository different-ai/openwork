import { expect } from "vitest";
import {
  control,
  createAndSelectWorkspace,
  evalIn,
  readComposerState,
  waitFor,
  writeComposerText,
} from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "reloading a session with a persisted composer draft keeps the renderer stable"
  : "composer draft reload skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

test.skipIf(!e2eTestsEnabled)(title, { timeout: 600_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "composer-draft-reload", host: place.host() });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-composer-draft-reload-${Date.now()}`,
  });
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`,
    { timeoutMs: 30_000, label: "new task control ready" },
  );
  const sessionId = await control(app, "session.create_task");
  expect(sessionId).toMatch(/^ses_/);

  const persistedDraft = "Keep this persisted draft through reload";
  await writeComposerText(app, persistedDraft);
  await waitFor(
    app,
    `localStorage.getItem("openwork.session-drafts.v2")?.includes(${JSON.stringify(persistedDraft)}) === true`,
    { timeoutMs: 10_000, label: "composer draft persisted" },
  );

  const previousTimeOrigin = await evalIn(app, "performance.timeOrigin");
  await evalIn(app, "location.reload(); true").catch(() => undefined);
  await waitFor(app, `performance.timeOrigin !== ${JSON.stringify(previousTimeOrigin)}`, {
    timeoutMs: 30_000,
    label: "renderer reloaded",
  });
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const rendererState = await evalIn(app, `({
    rootChildren: document.querySelector("#root")?.childElementCount ?? 0,
    bodyTextLength: document.body.innerText.trim().length,
  })`);
  const composerState = await readComposerState(app);

  expect(rendererState.rootChildren).toBeGreaterThan(0);
  expect(rendererState.bodyTextLength).toBeGreaterThan(40);
  expect(composerState.composerEditable).toBe(true);
  expect(composerState.draftText.trim()).toBe(persistedDraft);
  evidence.recordAssertionEvidence(
    "A persisted composer draft survives renderer reload without unmounting the app",
    `Session ${sessionId} reloaded with a non-empty root and preserved the exact draft text.`,
    true,
  );
});
