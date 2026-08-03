import { expect, test } from "vitest";
import { createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { photoRoll, screenshot, validate } from "@openwork/fraimz";
import { desktop } from "@openwork/hosts";

const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const title = appSpecsEnabled
  ? "app boots with a control route and meaningful visible content"
  : "app smoke skipped: set OPENWORK_EVAL_APP_SPECS=1 to opt in";

test.skipIf(!appSpecsEnabled)(title, async () => {
  await using app = await desktop({ name: "app-smoke" });
  await using roll = photoRoll("app-smoke");
  // A fresh, small directory that exists on whatever host runs the app.
  // NOT process.cwd(): that is the DRIVER's filesystem, which does not exist
  // when the app runs in a sandbox. NOT the repo root either: opening the whole
  // monorepo makes the engine scan node_modules and blocks the renderer past
  // 240s. createLocalWorkspace creates the folder, so it need not pre-exist.
  const workspace = await createAndSelectWorkspace(app, { path: `/tmp/openwork-app-smoke-${Date.now()}` });
  expect(workspace.workspaceId).toBeTruthy();
  const route = await evalIn(app, "window.__openworkControl.snapshot().route");
  expect(route).toBeTruthy();
  await waitFor(app, "document.body.innerText.trim().length > 40", { timeoutMs: 30_000, label: "rendered body text" });
  const shot = await screenshot(app);
  const seen = await validate(shot, [
    "A ready OpenWork workspace composer with meaningful visible content is on screen",
    "No generic error or 'Something went wrong' crash message is visible",
  ]);
  expect(seen.ok, seen.why).toBe(true);
  await roll.add(shot, seen);
});
