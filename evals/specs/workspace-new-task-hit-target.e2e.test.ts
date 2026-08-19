import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "the per-workspace New task plus stays clickable over a long truncated workspace name"
  : "workspace new-task hit target skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionCount(value: unknown): number {
  if (!Array.isArray(value)) throw new Error(`session.list_sessions did not return a list: ${JSON.stringify(value)}`);
  return value.length;
}

function pointFromEval(value: unknown, label: string): { x: number; y: number } {
  if (typeof value !== "string" || !value) throw new Error(`${label} did not return coordinates.`);
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || typeof parsed.x !== "number" || typeof parsed.y !== "number") {
    throw new Error(`${label} returned invalid coordinates: ${value}`);
  }
  return { x: parsed.x, y: parsed.y };
}

const plusSelector = '[data-workspace-new-task]';
const plusPointExpression = `(() => {
  const plus = document.querySelector(${JSON.stringify(plusSelector)});
  if (!(plus instanceof HTMLElement)) return "";
  plus.scrollIntoView({ block: "center" });
  const rect = plus.getBoundingClientRect();
  return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
})()`;

const plusHitExpression = `(() => {
  const plus = document.querySelector(${JSON.stringify(plusSelector)});
  if (!(plus instanceof HTMLElement)) {
    return { hitPlus: false, hitTitle: false, tag: "" };
  }
  const rect = plus.getBoundingClientRect();
  const node = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const header = plus.closest("[data-workspace-actions]")?.parentElement;
  const title = header?.querySelector(".ow-fade-truncate");
  return {
    hitPlus: plus.contains(node),
    hitTitle: Boolean(title && node instanceof Node && title.contains(node)),
    tag: node instanceof Element ? node.tagName.toLowerCase() : "",
  };
})()`;

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "workspace-new-task-hit-target" });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-kitchen-vercel-env-hit-target-${Date.now()}`,
  });

  await waitFor(app, `Boolean(document.querySelector(${JSON.stringify(plusSelector)}))`, {
    timeoutMs: 60_000,
    label: "per-workspace New task plus",
  });

  const point = pointFromEval(await evalIn(app, plusPointExpression), "workspace New task plus");
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await waitFor(app, `${plusHitExpression}.hitPlus === true`, {
    timeoutMs: 10_000,
    label: "New task plus is the topmost hit target",
  });

  const hit = await evalIn(app, plusHitExpression);
  if (!isRecord(hit) || hit.hitPlus !== true || hit.hitTitle !== false) {
    throw new Error(`New task plus was not the topmost hit target: ${JSON.stringify(hit)}`);
  }
  evidence.recordAssertionEvidence(
    "Hovering a long workspace name still leaves the New task plus as the click target",
    `elementFromPoint at the plus center hit the plus button and not the truncated title (node=${String(hit.tag)}).`,
    true,
  );

  const expandedBefore = await evalIn(
    app,
    `document.querySelector(${JSON.stringify(plusSelector)})?.closest("[data-workspace-actions]")?.parentElement?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")`,
  );
  const before = sessionCount(await control(app, "session.list_sessions"));
  await app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await waitFor(app, `window.location.hash.includes("/session/ses_")`, {
    timeoutMs: 60_000,
    label: "session created from the workspace New task plus",
  });
  const after = sessionCount(await control(app, "session.list_sessions"));
  expect(after).toBeGreaterThan(before);
  const expandedAfter = await evalIn(
    app,
    `document.querySelector(${JSON.stringify(plusSelector)})?.closest("[data-workspace-actions]")?.parentElement?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")`,
  );
  expect(expandedAfter).toBe(expandedBefore);
  evidence.recordAssertionEvidence(
    "Clicking the per-workspace New task plus creates a session instead of collapsing the workspace",
    `Sessions went from ${before} to ${after}, and the workspace expand state stayed ${JSON.stringify(expandedAfter)}.`,
    true,
  );
});
