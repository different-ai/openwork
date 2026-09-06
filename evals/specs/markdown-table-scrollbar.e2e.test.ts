import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { screenshot, validate } from "@openwork/test-evidence";
import { needs, test } from "@openwork/testkit";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "markdown table scrollbars stay interactive without opening the table source"
  : "markdown table scrollbar skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const wideTable = `# Wide table

| Name | Owner | Status | Region | Priority | Started | Updated | Budget | Forecast | Risk | Notes | Next step |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Alpha | Platform team | In progress | North America | High | 2026-08-01 | 2026-08-20 | $120,000 | $145,000 | Medium | Waiting for the final integration review | Schedule rollout |
| Beta | Product operations | Planned | Europe | Medium | 2026-09-01 | 2026-08-21 | $80,000 | $82,000 | Low | Requirements are approved | Start implementation |

End of report.
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test.skipIf(!enabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({
    name: "markdown-table-scrollbar",
    mode: process.env.OPENWORK_EVAL_CDP_URL?.trim() ? "attach" : "spawn",
  });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-markdown-table-scrollbar-${Date.now()}`,
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

  const seedReady = await evalIn(app, `window.__openworkControl.listActions().some((action) => action.id === "eval.artifact_tabs.seed_overflow" && !action.disabled)`);
  if (seedReady !== true) {
    await control(app, "browser.open_url", { url: "about:blank" }).catch(() => undefined);
  }
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "eval.artifact_tabs.seed_overflow" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "artifact seed action enabled",
  });
  await control(app, "eval.artifact_tabs.seed_overflow", { count: 12 });
  await waitFor(app, "Boolean(window.__artifactEditorView)", {
    timeoutMs: 30_000,
    label: "markdown artifact editor mounted",
  });
  const treeClosed = await evalIn(app, `(() => {
    const button = document.querySelector('button[aria-label="Hide workspace files"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(treeClosed).toBe(true);
  await waitFor(app, `!document.querySelector("[data-workspace-file-tree]")`, {
    timeoutMs: 10_000,
    label: "workspace tree closed for artifact evidence",
  });

  const seeded = await evalIn(app, `(() => {
    const view = window.__artifactEditorView;
    if (!view) return false;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(wideTable)} },
      selection: { anchor: ${wideTable.length} },
    });
    return true;
  })()`);
  expect(seeded).toBe(true);

  await waitFor(app, `(() => {
    const wrapper = document.querySelector(".cm-md-table");
    return wrapper instanceof HTMLElement && wrapper.scrollWidth > wrapper.clientWidth;
  })()`, {
    timeoutMs: 15_000,
    label: "wide rendered markdown table with horizontal scrollbar",
  });

  const beforeShot = await screenshot(app);
  const beforeSeen = await validate(beforeShot, [
    "The artifact editor shows a rendered markdown table at its left edge with columns including Name, Owner, and Status",
    "The table is rendered as cells rather than raw markdown pipes",
    "No error dialog or crash message is visible",
  ]);
  expect(beforeSeen.ok, beforeSeen.why).toBe(true);
  const afterScrollbarInteraction = await evalIn(app, `(() => {
    const wrapper = document.querySelector(".cm-md-table");
    const view = window.__artifactEditorView;
    if (!(wrapper instanceof HTMLElement)) return "";
    const defaultAllowed = wrapper.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    }));
    if (defaultAllowed) wrapper.scrollLeft = wrapper.scrollWidth;
    return JSON.stringify({
      defaultAllowed,
      rendered: wrapper.isConnected && wrapper.matches(".cm-md-table"),
      scrollLeft: wrapper.scrollLeft,
      sourceUnchanged: view?.state.doc.toString() === ${JSON.stringify(wideTable)},
    });
  })()`);
  if (typeof afterScrollbarInteraction !== "string" || !afterScrollbarInteraction) {
    throw new Error("Scrollbar result did not return JSON.");
  }
  const scrollbarState: unknown = JSON.parse(afterScrollbarInteraction);
  if (!isRecord(scrollbarState)) {
    throw new Error(`Scrollbar result returned invalid JSON: ${afterScrollbarInteraction}`);
  }
  expect(scrollbarState.defaultAllowed).toBe(true);
  expect(scrollbarState.rendered).toBe(true);
  expect(scrollbarState.scrollLeft).toEqual(expect.any(Number));
  expect(scrollbarState.scrollLeft).toBeGreaterThan(0);
  expect(scrollbarState.sourceUnchanged).toBe(true);
  evidence.recordAssertionEvidence(
    "Clicking a wide markdown table scrollbar scrolls the rendered table without entering source editing",
    `The table remained rendered, its horizontal scrollLeft advanced to ${String(scrollbarState.scrollLeft)} CSS pixels, and the markdown document stayed byte-identical.`,
    true,
  );
  const afterShot = await screenshot(app);
  const afterSeen = await validate(afterShot, [
    "The artifact editor shows the same rendered markdown table scrolled to its rightmost Next step column with Schedule rollout and Start implementation",
    "The table remains rendered as cells rather than raw markdown pipes after scrolling",
    "No error dialog or crash message is visible",
  ]);
  expect(afterSeen.ok, afterSeen.why).toBe(true);

  const clickedCell = await evalIn(app, `(() => {
    const cell = document.querySelector(".cm-md-table tbody td");
    if (!(cell instanceof HTMLElement)) return false;
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    return true;
  })()`);
  expect(clickedCell).toBe(true);
  await waitFor(app, `!document.querySelector(".cm-md-table")`, {
    timeoutMs: 10_000,
    label: "table cell click opens markdown source",
  });
  expect(await evalIn(app, `window.__artifactEditorView?.state.doc.toString() === ${JSON.stringify(wideTable)}`)).toBe(true);
  evidence.recordAssertionEvidence(
    "Clicking a rendered table cell still opens its markdown source for editing",
    "The table widget was replaced by the unchanged source after a body-cell mousedown, preserving the existing edit handoff.",
    true,
  );
});
