import { expect, test } from "vitest";
import type { Surface } from "@openwork/cdp";
import { createVisualEvidence, screenshot, validate } from "@openwork/test-evidence";
import { desktop } from "@openwork/hosts";
import {
  createAndSelectWorkspace,
  evalIn,
  readAvailableModels,
  readComposerState,
  readModelRecoveryState,
  seedUnavailableModel,
  selectModel,
  waitFor,
  waitForText,
  writeComposerText,
} from "@openwork/behaviors";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const appTitle = e2eTestsEnabled
  ? "available models are selectable and a disappeared model blocks until recovery"
  : "models available skipped: set OPENWORK_EVAL_E2E_TESTS=1 to opt in";
const guidance = "The model you were using is no longer available, please select a different model for this session.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function executeControl(app: Surface, action: string, args?: unknown): Promise<unknown> {
  const value = await evalIn(
    app,
    `window.__openworkControl.execute(${JSON.stringify(action)}, ${JSON.stringify(args ?? null)})`,
    { awaitPromise: true },
  );
  if (!isRecord(value) || value.ok !== true) throw new Error(`Control action ${action} failed: ${JSON.stringify(value)}`);
  return value.result;
}

async function ensureSession(app: Surface, path: string): Promise<string> {
  // Onboarding leaves the app on the workspace's session surface with the
  // engine configured and a session already open — the state a real first
  // run produces, and all the model helpers need.
  const { workspaceId } = await createAndSelectWorkspace(app, { path });
  return workspaceId;
}

async function setComposerText(app: Surface, text: string): Promise<void> {
  await writeComposerText(app, text);
}

test.skipIf(!e2eTestsEnabled)(appTitle, async () => {
  await using app = await desktop({ name: "models-available" });
  await using visualEvidence = createVisualEvidence("models-available");
  const workspacePath = `/tmp/openwork-models-available-${Date.now()}`;
  await ensureSession(app, workspacePath);

  // The engine's model catalog can land after the picker first paints its
  // "No models" state, so poll until models appear instead of reading the
  // first paint (observed live: same boot, 0 models at first read, 7 shortly
  // after).
  let models = await readAvailableModels(app);
  const catalogDeadline = Date.now() + 90_000;
  while (models.length === 0 && Date.now() < catalogDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    models = await readAvailableModels(app);
  }
  expect(models.length).toBeGreaterThan(0);
  expect(models.some((model) => model.selectable)).toBe(true);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The Models picker visibly contains selectable models",
      "No empty-model failure or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await visualEvidence.recordScreenshot(shot, seen);
  }

  const model = models.find((candidate) => candidate.selectable);
  expect(model).toBeTruthy();
  if (!model) throw new Error("No selectable model was returned.");
  const selected = await selectModel(app, model.id);
  expect(selected.id).toBe(model.id);
  expect(selected.selected).toBe(true);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The composer is visibly ready after a model is selected",
      "No unavailable-model warning or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await visualEvidence.recordScreenshot(shot, seen);
  }

  const seeded = await seedUnavailableModel(app);
  expect(seeded.unavailableModelId).toBeTruthy();
  expect(seeded.availableModelId).toBeTruthy();
  await waitForText(app, "Model no longer available", { timeoutMs: 30_000 });
  await waitForText(app, seeded.unavailableModelId, { timeoutMs: 30_000 });
  let recovery = await readModelRecoveryState(app);
  expect(recovery.warningVisible).toBe(true);
  await executeControl(app, "session.model_picker.open");
  await waitFor(app, `Boolean(document.querySelector('[data-slot="dialog-content"]'))`, {
    timeoutMs: 30_000,
    label: "opened Models picker dialog",
  });
  await waitForText(app, "Models", { timeoutMs: 30_000 });
  await waitForText(app, "Done", { timeoutMs: 30_000 });
  await waitForText(app, guidance, { timeoutMs: 30_000 });
  recovery = await readModelRecoveryState(app);
  expect(recovery.pickerOpen).toBe(true);
  expect(recovery.guidanceVisible).toBe(true);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "A Model no longer available warning blocks the disappeared model",
      "The open Models picker explains that a different model must be selected",
      "No unrelated generic error or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await visualEvidence.recordScreenshot(shot, seen);
  }

  await selectModel(app, seeded.availableModelId);
  await setComposerText(app, "Model recovery can continue.");
  recovery = await readModelRecoveryState(app);
  const composer = await readComposerState(app);
  expect(recovery.guidanceVisible).toBe(false);
  expect(recovery.warningVisible).toBe(false);
  expect(composer.draftText).toContain("Model recovery can continue.");
  expect(composer.runTaskEnabled).toBe(true);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The recovered composer visibly contains the Model recovery can continue draft",
      "No unavailable-model warning or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await visualEvidence.recordScreenshot(shot, seen);
  }
});
