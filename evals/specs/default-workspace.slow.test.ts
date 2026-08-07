import { expect, test } from "vitest";
import type { Surface } from "@openwork/cdp";
import { photoRoll, screenshot, validate } from "@openwork/fraimz";
import { desktop } from "@openwork/hosts";
import {
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
  ? "a fresh desktop seeds a global default workspace so models and chat work without creating a workspace"
  : "default-workspace skipped: set OPENWORK_EVAL_APP_SPECS=1 to opt in";
const prompt = "Tell me in one sentence what OpenWork is.";

interface DefaultWorkspaceFacts {
  workspaceSelected: boolean;
  noWorkspaceEmptyState: boolean;
  routeHasWorkspace: boolean;
  workspaceNameVisible: string;
}

async function readDefaultWorkspaceState(app: Surface): Promise<DefaultWorkspaceFacts> {
  const value = await evalIn(app, `(() => {
    const text = document.body.innerText;
    return {
      workspaceSelected: Boolean(localStorage.getItem("openwork.react.activeWorkspace"))
        || /\\/workspace\\/[^/?#]+/.test(window.location.hash),
      noWorkspaceEmptyState: text.includes("Create or connect a workspace"),
      routeHasWorkspace: /\\/workspace\\/[^/?#]+/.test(window.location.hash),
      workspaceNameVisible: text.includes("OpenWork Chat") ? "OpenWork Chat" : "",
    };
  })()`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Default workspace state was not an object.");
  }
  return {
    workspaceSelected: Reflect.get(value, "workspaceSelected") === true,
    noWorkspaceEmptyState: Reflect.get(value, "noWorkspaceEmptyState") === true,
    routeHasWorkspace: Reflect.get(value, "routeHasWorkspace") === true,
    workspaceNameVisible: String(Reflect.get(value, "workspaceNameVisible") ?? ""),
  };
}

test.skipIf(!appSpecsEnabled)(title, async () => {
  await using app = await desktop({ name: "default-workspace" });
  await using roll = photoRoll("default-workspace");

  // Frame 1: no "Create or connect a workspace" empty state. A fresh profile
  // with no user-created workspace lands directly in a usable default
  // workspace that the desktop main process seeded at boot.
  let state = await readDefaultWorkspaceState(app);
  const bodyText = String(await evalIn(app, "document.body.innerText"));
  expect(state.workspaceSelected, `active workspace should be present. Body text: ${bodyText.slice(0, 300)}`).toBe(true);
  expect(state.noWorkspaceEmptyState, "no Create or connect a workspace empty state").toBe(false);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "A workspace is selected with no 'Create or connect a workspace' empty state",
      "No generic error or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  // Frame 2: the model picker lists selectable models without binding a
  // project, because the managed engine is up and reading the provider list.
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
      "The Models picker visibly lists selectable models without binding a workspace",
      "No empty-model failure or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  const model = models.find((candidate) => candidate.selectable);
  expect(model).toBeTruthy();
  if (!model) throw new Error("No selectable model was returned.");
  const selected = await selectModel(app, model.id);
  expect(selected.id).toBe(model.id);

  // Frame 3: a direct question runs in the default workspace and streams a
  // reply, not blocked by any workspace-selection requirement.
  const composer = await readComposerState(app);
  expect(composer.route).toContain("/workspace/");
  expect(composer.runTaskVisible).toBe(true);
  const sent = await sendComposerMessage(app, prompt);
  expect(sent.userMessageCount).toBeGreaterThan(0);
  await waitForText(app, prompt, { timeoutMs: 30_000 });
  const reply = await waitForAssistantReply(app, { timeoutMs: 180_000 });
  expect(reply.assistantMessageCount).toBeGreaterThan(0);
  expect(reply.text.trim().length).toBeGreaterThan(0);
  await waitUntilTextStable(app, { quietMs: 8_000, timeoutMs: 240_000 });
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "A direct chat in the default workspace produced a substantive assistant reply",
      "No response failure or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  // Frame 4: Settings -> AI Providers shows connected providers because the
  // engine is running, without a manually-created workspace.
  const workspaceId = state.routeHasWorkspace
    ? (await evalIn(app, `(() => { const m = /\\/workspace\\/([^/?#]+)/.exec(window.location.hash); return m?.[1] ?? ""; })()`))
    : "";
  if (workspaceId) {
    await go(app, `/workspace/${workspaceId}/settings/ai`);
    await waitFor(app, `document.body.innerText.includes("AI Providers")`, {
      timeoutMs: 60_000,
      label: "AI Providers settings page",
    });
    await waitFor(app, `(() => {
      const text = document.body.innerText;
      return !text.includes("No providers") && /providers?\\b/i.test(text);
    })()`, { timeoutMs: 60_000, label: "connected providers listed" });
    const providersState = await evalIn(app, `({
      hasTitle: document.body.innerText.includes("AI Providers"),
      hasProviders: /\\d+ providers?\\b/i.test(document.body.innerText),
      empty: document.body.innerText.includes("No providers"),
    })`);
    const ok = typeof providersState === "object" && providersState !== null
      && Reflect.get(providersState, "hasTitle") === true
      && Reflect.get(providersState, "hasProviders") === true
      && Reflect.get(providersState, "empty") !== true;
    expect(ok, `AI Providers page should list providers: ${JSON.stringify(providersState)}`).toBe(true);
    {
      const shot = await screenshot(app);
      const seen = await validate(shot, [
        "The AI Providers settings page lists connected providers without a created workspace",
        "No 'No providers' empty state or 'Something went wrong' crash message is visible",
      ]);
      expect(seen.ok, seen.why).toBe(true);
      await roll.add(shot, seen);
    }
  }
});