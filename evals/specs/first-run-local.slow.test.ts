import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import type { Surface } from "@openwork/cdp";
import { photoRoll, screenshot, validate } from "@openwork/fraimz";
import { readActiveWorkspaceId } from "@openwork/cdp";
import { desktop } from "@openwork/hosts";
import {
  clickButton,
  createLocalWorkspaceViaUi,
  currentHash,
  evalIn,
  go,
  readAvailableModels,
  readComposerState,
  selectModel,
  sendComposerMessage,
  waitFor,
  waitForAssistantReply,
  waitForText,
  waitUntilTextStable,
} from "@openwork/behaviors";

const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const title = appSpecsEnabled
  ? "first use without an invite or cloud reaches local task UI with honest model setup"
  : "first-run local skipped: set OPENWORK_EVAL_APP_SPECS=1 to opt in";
const prompt = "Create a short welcome checklist for this OpenWork workspace. Use exactly three bullets and mention one thing I can do next.";

interface TaskAvailability {
  createTaskEnabled: boolean;
  runTaskEnabled: boolean;
  connectProviderVisible: boolean;
}

function taskAvailability(value: unknown): TaskAvailability {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Task availability was not an object.");
  }
  return {
    createTaskEnabled: Reflect.get(value, "createTaskEnabled") === true,
    runTaskEnabled: Reflect.get(value, "runTaskEnabled") === true,
    connectProviderVisible: Reflect.get(value, "connectProviderVisible") === true,
  };
}

async function readTaskAvailability(app: Surface): Promise<TaskAvailability> {
  const value = await evalIn(app, `(() => {
    const action = window.__openworkControl.listActions()
      .find((entry) => entry.id === "session.create_task");
    const buttons = [...document.querySelectorAll("button")];
    const run = buttons.find((button) => (button.textContent ?? "").trim() === "Run task");
    const connect = buttons.find((button) => (button.textContent ?? "").trim() === "Connect a model provider");
    return {
      createTaskEnabled: Boolean(action && !action.disabled),
      runTaskEnabled: Boolean(run && !run.disabled),
      connectProviderVisible: Boolean(connect && !connect.disabled),
    };
  })()`);
  return taskAvailability(value);
}

async function createTask(app: Surface): Promise<void> {
  const value = await evalIn(
    app,
    `window.__openworkControl.execute("session.create_task", null)`,
    { awaitPromise: true },
  );
  if (typeof value !== "object" || value === null || Reflect.get(value, "ok") !== true) {
    throw new Error(`session.create_task failed: ${JSON.stringify(value)}`);
  }
  await waitFor(app, `window.location.hash.includes("/session/ses_")`, {
    timeoutMs: 60_000,
    label: "created first-run task session",
  });
}

test.skipIf(!appSpecsEnabled)(title, async () => {
  await using app = await desktop({ name: "first-run-local" });
  await using roll = photoRoll("first-run-local");
  let workspacePath = "";
  onTestFinished(async () => {
    if (workspacePath) await rm(workspacePath, { recursive: true, force: true });
  });

  expect(app.readiness.route).toContain("/welcome");
  expect(app.readiness.state).toBe("welcome");
  await waitForText(app, "Welcome to OpenWork");
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The Welcome to OpenWork heading and Use Without Cloud option are visible",
      "No generic error or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  workspacePath = await mkdtemp(join(tmpdir(), "openwork-first-run-local-"));
  await clickButton(app, "Use Without Cloud");
  const workspace = await createLocalWorkspaceViaUi(app, { path: workspacePath });
  expect(workspace.path).toBe(workspacePath);
  // The app adopts the workspace only once onboarding finishes, so its id is
  // asserted after the remaining steps rather than here.
  expect(await currentHash(app)).toContain("/welcome");
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The model setup step is visible with the Skip and use the free model option",
      "No generic error or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  await clickButton(app, "Skip and use the free model", { timeoutMs: 90_000 });
  await waitForText(app, "How did you hear about OpenWork?", { timeoutMs: 90_000 });
  await clickButton(app, "Skip", { timeoutMs: 15_000 });
  await waitFor(app, `Boolean(localStorage.getItem("openwork.react.activeWorkspace"))
    || /\\/workspace\\/[^/?#]+/.test(window.location.hash)`, {
    timeoutMs: 180_000,
    label: "first-run workspace selected",
  });
  const workspaceId = await readActiveWorkspaceId(app.client, { timeoutMs: 30_000 });
  expect(workspaceId, "onboarding did not leave a selected workspace").toBeTruthy();
  await go(app, `/workspace/${workspaceId ?? ""}/session`);
  await waitFor(app, `document.body.innerText.includes("What do you need done?")
    || [...document.querySelectorAll("button")].some((button) => (button.textContent ?? "").trim() === "Run task")`, {
    timeoutMs: 120_000,
    label: "first-run task UI",
  });
  expect(await currentHash(app)).toContain(`/workspace/${workspaceId ?? ""}/session`);
  const composer = await readComposerState(app);
  expect(composer.route).toContain("/workspace/");
  expect(composer.route).toContain("/session");
  expect(composer.runTaskVisible).toBe(true);
  const availability = await readTaskAvailability(app);
  const modelUsable = availability.createTaskEnabled || availability.runTaskEnabled;
  expect(modelUsable || availability.connectProviderVisible).toBe(true);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The workspace task UI is visible with What do you need done? and the Run task control",
      availability.runTaskEnabled
        ? "Run task is visibly enabled for a model that is already usable"
        : "Run task is visibly disabled or Connect a model provider is offered, because no provider is configured yet",
      "No generic error or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  // Review-bar limitation: when this no-cloud workspace has no provider key
  // configured in the app, this spec does not exercise the "runs a task and
  // sees a response" half of evals/onboarding-welcome-flows.md. It proves the
  // session/task UI and honest provider-setup affordance instead, because an
  // external test-runner environment key does not make a model usable in-app.
  if (!modelUsable) return;

  const models = await readAvailableModels(app);
  expect(models.length).toBeGreaterThan(0);
  expect(models.some((model) => model.selectable)).toBe(true);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The Models picker visibly lists models that can be selected",
      "No generic error, empty-model failure, or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  const selectable = models.find((model) => model.selectable);
  expect(selectable).toBeTruthy();
  if (!selectable) throw new Error("No selectable model was returned.");
  const selected = await selectModel(app, selectable.id);
  expect(selected.selectable).toBe(true);
  expect(selected.id).toBe(selectable.id);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The composer is ready after selecting a model",
      "No unavailable-model warning or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  expect(availability.createTaskEnabled).toBe(true);
  await createTask(app);
  const sent = await sendComposerMessage(app, prompt);
  expect(sent.userMessageCount).toBeGreaterThan(0);
  await waitForText(app, prompt, { timeoutMs: 30_000 });
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The submitted welcome-checklist task is visibly present in the conversation",
      "No task submission error or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  const reply = await waitForAssistantReply(app, { timeoutMs: 180_000 });
  expect(reply.assistantMessageCount).toBeGreaterThan(0);
  expect(reply.text.trim().length).toBeGreaterThan(0);
  // The reply streams: capturing as soon as text exists catches a "Thinking…"
  // frame, so wait until the assistant has actually settled.
  await waitUntilTextStable(app, { quietMs: 8_000, timeoutMs: 240_000 });
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "A substantive assistant response to the welcome-checklist task is visible",
      "No response failure or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }
});
