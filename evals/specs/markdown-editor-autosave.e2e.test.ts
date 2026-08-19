import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "markdown artifacts autosave without Save/Discard buttons and format from the right-click menu"
  : "markdown editor autosave skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const activeArtifactPath = "artifacts/overflow-tab-12.md";
const untouchedArtifactPath = "artifacts/overflow-tab-11.md";
const typedSentence = "Autosaved without buttons.";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFileExpression(workspaceId: string, path: string): string {
  return `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "";
    const response = await fetch(
      "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/files/content?path=" + encodeURIComponent(${JSON.stringify(path)}),
      { headers: { Authorization: "Bearer " + token } },
    );
    if (!response.ok) return "";
    const json = await response.json();
    return typeof json.content === "string" ? json.content : "";
  })()`;
}

async function waitForFileContent(
  app: Surface,
  workspaceId: string,
  path: string,
  predicate: (content: string) => boolean,
  label: string,
): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = await evalIn(app, readFileExpression(workspaceId, path), { awaitPromise: true });
    last = typeof value === "string" ? value : "";
    if (predicate(last)) return last;
    await sleep(250);
  }
  throw new Error(`${label}: file ${path} never matched; last content was ${JSON.stringify(last)}`);
}

async function rightClick(app: Surface, selector: string): Promise<void> {
  const rawPoint = await evalIn(app, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement)) return "";
    target.scrollIntoView({ block: "center" });
    const rect = target.getBoundingClientRect();
    return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  })()`);
  if (typeof rawPoint !== "string" || !rawPoint) throw new Error(`Right-click target ${selector} did not return coordinates.`);
  const point: unknown = JSON.parse(rawPoint);
  if (!isRecord(point) || typeof point.x !== "number" || typeof point.y !== "number") {
    throw new Error(`Right-click target ${selector} returned invalid coordinates: ${rawPoint}`);
  }
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "right", clickCount: 1 });
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "right", clickCount: 1 });
}

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({
    name: "markdown-editor-autosave",
    mode: process.env.OPENWORK_EVAL_CDP_URL?.trim() ? "attach" : "spawn",
  });
  const workspace = await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-markdown-editor-autosave-${Date.now()}`,
  });

  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "new task action enabled",
  });
  await control(app, "session.create_task");
  await waitFor(app, `String(window.__openworkControl.snapshot().route || "").includes("/session/")`, {
    timeoutMs: 30_000,
    label: "session route open",
  });

  // Mount the side panel so the dev seed action registers, then open markdown artifacts.
  const seedReady = await evalIn(app, `window.__openworkControl.listActions().some((action) => action.id === "eval.artifact_tabs.seed_overflow" && !action.disabled)`);
  if (seedReady !== true) {
    // browser.open_url sets the side panel open before navigating; the
    // navigation itself can race the internal tab bootstrap, which is fine —
    // we only need the panel mounted so its dev seed action registers.
    await control(app, "browser.open_url", { url: "about:blank" }).catch(() => undefined);
  }
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "eval.artifact_tabs.seed_overflow" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "artifact seed action enabled",
  });
  await control(app, "eval.artifact_tabs.seed_overflow", { count: 12 });

  await waitFor(app, "Boolean(window.__artifactEditorView)", {
    timeoutMs: 30_000,
    label: "markdown artifact opened directly in the editor",
  });

  const header = await evalIn(app, `(() => {
    const buttons = Array.from(document.querySelectorAll("button")).map((button) => (button.textContent ?? "").trim());
    return JSON.stringify({
      hasSave: buttons.includes("Save") || buttons.includes("Saving"),
      hasDiscard: buttons.includes("Discard"),
      mentionsBytes: /\\d+(\\.\\d+)?\\s*(bytes|KB|MB|GB|TB)/.test(document.body.innerText),
    });
  })()`);
  if (typeof header !== "string") throw new Error("Header probe did not return JSON.");
  const headerState: unknown = JSON.parse(header);
  if (!isRecord(headerState)) throw new Error(`Header probe returned invalid JSON: ${header}`);
  expect(headerState.hasSave).toBe(false);
  expect(headerState.hasDiscard).toBe(false);
  expect(headerState.mentionsBytes).toBe(false);
  evidence.recordAssertionEvidence(
    "The markdown editor exposes no Save or Discard buttons and no file byte count",
    "With a markdown artifact open for direct editing, no button was labelled Save, Saving, or Discard, and no byte/KB size readout was visible.",
    true,
  );

  const baseline = await waitForFileContent(
    app,
    workspace.workspaceId,
    activeArtifactPath,
    (content) => content.startsWith("# Overflow tab 12"),
    "seeded artifact on disk",
  );
  const untouchedBaseline = await waitForFileContent(
    app,
    workspace.workspaceId,
    untouchedArtifactPath,
    (content) => content.startsWith("# Overflow tab 11"),
    "sibling artifact on disk",
  );

  const typed = await evalIn(app, `(() => {
    const view = window.__artifactEditorView;
    if (!view) return false;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\\n" + ${JSON.stringify(typedSentence)} } });
    return true;
  })()`);
  expect(typed).toBe(true);

  const savedContent = await waitForFileContent(
    app,
    workspace.workspaceId,
    activeArtifactPath,
    (content) => content.includes(typedSentence),
    "autosave after typing",
  );
  expect(savedContent).toBe(`${baseline}\n${typedSentence}`);
  await waitFor(app, `document.body.innerText.includes("Saved")`, {
    timeoutMs: 15_000,
    label: "Saved indicator after autosave",
  });
  evidence.recordAssertionEvidence(
    "Typing in the markdown editor persists to disk without pressing any button",
    `The artifact file content became exactly the baseline plus ${JSON.stringify(typedSentence)} and the header showed Saved.`,
    true,
  );

  // Format the first line via the right-click menu.
  const selected = await evalIn(app, `(() => {
    const view = window.__artifactEditorView;
    if (!view) return false;
    view.dispatch({ selection: { anchor: 0 } });
    return true;
  })()`);
  expect(selected).toBe(true);
  await rightClick(app, ".cm-line");
  await waitFor(app, `(() => {
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());
    return ["Heading 1", "Heading 2", "Heading 3", "Bold", "Bullet list", "Quote"].every((label) => labels.includes(label));
  })()`, { timeoutMs: 10_000, label: "markdown formatting context menu open" });

  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "A markdown editor is open with a right-click context menu offering Heading 1, Heading 2, Heading 3 and other formatting options",
      "The editor header shows a Saved status label and contains no button labelled Save or Discard",
      "No error dialog or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const clickedHeading = await evalIn(app, `(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')]
      .find((entry) => entry.textContent?.trim() === "Heading 2");
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`);
  expect(clickedHeading).toBe(true);

  await waitFor(app, `window.__artifactEditorView?.state.doc.line(1).text.startsWith("## ")`, {
    timeoutMs: 10_000,
    label: "first line converted to a level-2 heading",
  });
  const headingContent = await waitForFileContent(
    app,
    workspace.workspaceId,
    activeArtifactPath,
    (content) => content.startsWith("## Overflow tab 12"),
    "autosave after heading formatting",
  );
  expect(headingContent).toBe(`#${baseline}\n${typedSentence}`);
  evidence.recordAssertionEvidence(
    "The right-click menu converts the current line to the chosen heading level and the change autosaves",
    "Heading 2 rewrote the first line from `# Overflow tab 12` to `## Overflow tab 12`, and the file on disk matched exactly.",
    true,
  );

  const untouchedAfter = await evalIn(app, readFileExpression(workspace.workspaceId, untouchedArtifactPath), { awaitPromise: true });
  expect(untouchedAfter).toBe(untouchedBaseline);
  evidence.recordAssertionEvidence(
    "Autosave only writes the artifact being edited",
    "A sibling markdown artifact opened in another tab kept byte-identical content after edits and formatting in the active tab.",
    true,
  );
});
