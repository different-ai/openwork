import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { screenshot } from "@openwork/test-evidence";
import { needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "workspace names in the sidebar stay fully visible whenever they fit"
  : "sidebar workspace title fit skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const runId = Date.now().toString(36);
const shortName = `Yonder-${runId}`;
const longName = `openwork-workspace-title-that-keeps-going-past-the-sidebar-${runId}`;

const workspaceTitleStateExpression = (name: string) => `(() => {
  const label = [...document.querySelectorAll("[data-sidebar-workspace-title]")]
    .find((node) => (node.textContent ?? "").trim() === ${JSON.stringify(name)});
  if (!(label instanceof HTMLElement)) return null;
  const parent = label.parentElement;
  const textRange = document.createRange();
  textRange.selectNodeContents(label);
  const text = textRange.getBoundingClientRect();
  const box = label.getBoundingClientRect();
  return {
    boxRight: box.right,
    boxWidth: box.width,
    clientWidth: label.clientWidth,
    maskImage: getComputedStyle(label).maskImage,
    overflowing: label.dataset.overflowing ?? "",
    parentContentRight: parent ? parent.getBoundingClientRect().right - parseFloat(getComputedStyle(parent).paddingRight) : null,
    scrollWidth: label.scrollWidth,
    textRight: text.right,
  };
})()`;

const railPointExpression = `(() => {
  const rail = document.querySelector('[data-sidebar="rail"]');
  if (!(rail instanceof HTMLElement)) return null;
  const rect = rail.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`;

type WorkspaceTitleState = {
  boxRight: number;
  boxWidth: number;
  clientWidth: number;
  maskImage: string;
  overflowing: string;
  parentContentRight: number | null;
  scrollWidth: number;
  textRight: number;
};

type Point = { x: number; y: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTitleState(value: unknown, name: string): WorkspaceTitleState {
  if (!isRecord(value)) throw new Error(`Could not read the sidebar workspace title ${JSON.stringify(name)}: ${JSON.stringify(value)}`);
  const { boxRight, boxWidth, clientWidth, maskImage, overflowing, parentContentRight, scrollWidth, textRight } = value;
  if (
    typeof boxRight !== "number" ||
    typeof boxWidth !== "number" ||
    typeof clientWidth !== "number" ||
    typeof maskImage !== "string" ||
    typeof overflowing !== "string" ||
    (parentContentRight !== null && typeof parentContentRight !== "number") ||
    typeof scrollWidth !== "number" ||
    typeof textRight !== "number"
  ) {
    throw new Error(`Sidebar workspace title state had an unexpected shape: ${JSON.stringify(value)}`);
  }
  return { boxRight, boxWidth, clientWidth, maskImage, overflowing, parentContentRight, scrollWidth, textRight };
}

function readPoint(value: unknown, label: string): Point {
  if (!isRecord(value) || typeof value.x !== "number" || typeof value.y !== "number") {
    throw new Error(`${label} had an unexpected shape: ${JSON.stringify(value)}`);
  }
  return { x: value.x, y: value.y };
}

function expectFullyVisible(state: WorkspaceTitleState, name: string) {
  expect(state.scrollWidth, `${name} should fit inside its box`).toBeLessThanOrEqual(state.clientWidth + 1);
  expect(state.maskImage, `${name} must not be masked when it fits`).toBe("none");
  expect(state.overflowing, `${name} must not report hidden text`).toBe("");
  // The label box spans the row so any fade sits on the row edge, never on the last letters.
  if (state.parentContentRight !== null) {
    expect(Math.abs(state.boxRight - state.parentContentRight), `${name} box should reach the row's content edge`).toBeLessThanOrEqual(1);
  }
  expect(state.textRight, `${name} text should end before the box edge`).toBeLessThan(state.boxRight);
}

async function dragRail(app: Awaited<ReturnType<typeof desktop>>, deltaX: number) {
  const rail = readPoint(await evalIn(app, railPointExpression), "sidebar resize rail");
  await app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rail.x, y: rail.y, button: "left", clickCount: 1 });
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rail.x + deltaX, y: rail.y, button: "left" });
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rail.x + deltaX, y: rail.y, button: "left", clickCount: 1 });
}

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "sidebar-workspace-title-fit" });
  await createAndSelectWorkspace(app, { path: `/tmp/${shortName}` });
  await waitFor(app, `Boolean(${workspaceTitleStateExpression(shortName)})`, {
    timeoutMs: 60_000,
    label: "short workspace name in the sidebar",
  });

  const shortAtDefault = readTitleState(await evalIn(app, workspaceTitleStateExpression(shortName)), shortName);
  expectFullyVisible(shortAtDefault, shortName);
  evidence.recordAssertionEvidence(
    "A workspace name that fits the default sidebar is fully visible with no fade",
    `${JSON.stringify(shortName)} measured ${shortAtDefault.scrollWidth}px inside a ${shortAtDefault.clientWidth}px box, reported no hidden text, and had no mask.`,
    true,
  );
  await screenshot(app);

  await control(app, "workspace.create", { path: `/tmp/${longName}` }, { timeoutMs: 60_000 });
  await waitFor(app, `${workspaceTitleStateExpression(longName)}?.scrollWidth > ${workspaceTitleStateExpression(longName)}?.clientWidth`, {
    timeoutMs: 60_000,
    label: "overflowing workspace name in the sidebar",
  });
  await waitFor(app, `${workspaceTitleStateExpression(longName)}?.overflowing === "true"`, {
    timeoutMs: 10_000,
    label: "overflowing workspace name reports hidden text",
  });

  const longAtDefault = readTitleState(await evalIn(app, workspaceTitleStateExpression(longName)), longName);
  expect(longAtDefault.maskImage).not.toBe("none");
  evidence.recordAssertionEvidence(
    "A workspace name wider than the sidebar fades only because text is hidden",
    `${JSON.stringify(longName)} measured ${longAtDefault.scrollWidth}px inside a ${longAtDefault.clientWidth}px box and faded its clipped edge.`,
    true,
  );
  const shortBesideLong = readTitleState(await evalIn(app, workspaceTitleStateExpression(shortName)), shortName);
  expectFullyVisible(shortBesideLong, shortName);
  await screenshot(app);

  await dragRail(app, 340);
  await waitFor(app, `${workspaceTitleStateExpression(longName)}?.overflowing === ""`, {
    timeoutMs: 15_000,
    label: "expanded sidebar exposes the full workspace name",
  });

  const longExpanded = readTitleState(await evalIn(app, workspaceTitleStateExpression(longName)), longName);
  expectFullyVisible(longExpanded, longName);
  const shortExpanded = readTitleState(await evalIn(app, workspaceTitleStateExpression(shortName)), shortName);
  expectFullyVisible(shortExpanded, shortName);
  evidence.recordAssertionEvidence(
    "Widening the sidebar until a long workspace name fits removes its fade",
    `After resizing, ${JSON.stringify(longName)} fits ${longExpanded.scrollWidth}px inside ${longExpanded.clientWidth}px with no mask; the short name stayed unfaded throughout.`,
    true,
  );
  await screenshot(app);
});
