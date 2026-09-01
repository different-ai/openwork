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

/** Workspace names use the same title viewport as task rows, so read the same state. */
const workspaceTitleStateExpression = (name: string) => `(() => {
  const text = [...document.querySelectorAll("[data-sidebar-workspace-title] [data-session-title-text]")]
    .find((node) => (node.textContent ?? "").trim() === ${JSON.stringify(name)});
  if (!(text instanceof HTMLElement) || !(text.parentElement instanceof HTMLElement)) return null;
  const viewport = text.parentElement;
  const button = viewport.closest("[data-sidebar-workspace-title]");
  const viewportRect = viewport.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  // The expand chevron is the header's own direct child; the avatar picker inside
  // the row also carries aria-expanded, so do not search descendants.
  const header = button.parentElement?.parentElement;
  const chevron = header ? header.querySelector(":scope > [aria-expanded]") : null;
  return {
    buttonContentRight: buttonRect.right - parseFloat(getComputedStyle(button).paddingRight),
    chevronLeft: chevron ? chevron.getBoundingClientRect().left : null,
    clientWidth: viewport.clientWidth,
    hiddenEdges: viewport.dataset.sessionTitleHiddenEdges ?? "",
    maskImage: getComputedStyle(viewport).maskImage,
    scrollWidth: text.scrollWidth,
    viewportRight: viewportRect.right,
    x: viewportRect.left + Math.min(viewportRect.width / 2, 60),
    y: viewportRect.top + viewportRect.height / 2,
  };
})()`;

const railPointExpression = `(() => {
  const rail = document.querySelector('[data-sidebar="rail"]');
  if (!(rail instanceof HTMLElement)) return null;
  const rect = rail.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`;

type WorkspaceTitleState = {
  buttonContentRight: number;
  chevronLeft: number | null;
  clientWidth: number;
  hiddenEdges: string;
  maskImage: string;
  scrollWidth: number;
  viewportRight: number;
  x: number;
  y: number;
};

type Point = { x: number; y: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTitleState(value: unknown, name: string): WorkspaceTitleState {
  if (!isRecord(value)) throw new Error(`Could not read the sidebar workspace title ${JSON.stringify(name)}: ${JSON.stringify(value)}`);
  const { buttonContentRight, chevronLeft, clientWidth, hiddenEdges, maskImage, scrollWidth, viewportRight, x, y } = value;
  if (
    typeof buttonContentRight !== "number" ||
    (chevronLeft !== null && typeof chevronLeft !== "number") ||
    typeof clientWidth !== "number" ||
    typeof hiddenEdges !== "string" ||
    typeof maskImage !== "string" ||
    typeof scrollWidth !== "number" ||
    typeof viewportRight !== "number" ||
    typeof x !== "number" ||
    typeof y !== "number"
  ) {
    throw new Error(`Sidebar workspace title state had an unexpected shape: ${JSON.stringify(value)}`);
  }
  return { buttonContentRight, chevronLeft, clientWidth, hiddenEdges, maskImage, scrollWidth, viewportRight, x, y };
}

function readPoint(value: unknown, label: string): Point {
  if (!isRecord(value) || typeof value.x !== "number" || typeof value.y !== "number") {
    throw new Error(`${label} had an unexpected shape: ${JSON.stringify(value)}`);
  }
  return { x: value.x, y: value.y };
}

function expectFullyVisible(state: WorkspaceTitleState, name: string) {
  expect(state.scrollWidth, `${name} should fit inside its viewport`).toBeLessThanOrEqual(state.clientWidth + 1);
  expect(state.hiddenEdges, `${name} must report no hidden edges`).toBe("none");
  expect(state.maskImage, `${name} must not be masked when it fits`).toBe("none");
}

function expectViewportSpansRow(state: WorkspaceTitleState, name: string) {
  // The viewport reaches the row's reserved action padding, so any fade sits on
  // the row edge and the text never runs under the trailing icons.
  expect(Math.abs(state.viewportRight - state.buttonContentRight), `${name} viewport should reach the row's content edge`).toBeLessThanOrEqual(1);
  if (state.chevronLeft !== null) {
    expect(state.viewportRight, `${name} viewport must stop before the expand chevron`).toBeLessThanOrEqual(state.chevronLeft);
  }
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
  expectViewportSpansRow(shortAtDefault, shortName);
  evidence.recordAssertionEvidence(
    "A workspace name that fits the default sidebar is fully visible with no fade",
    `${JSON.stringify(shortName)} measured ${shortAtDefault.scrollWidth}px inside a ${shortAtDefault.clientWidth}px viewport, reported no hidden edges, and had no mask.`,
    true,
  );
  await screenshot(app);

  await control(app, "workspace.create", { path: `/tmp/${longName}` }, { timeoutMs: 60_000 });
  await waitFor(app, `${workspaceTitleStateExpression(longName)}?.hiddenEdges === "end"`, {
    timeoutMs: 60_000,
    label: "overflowing workspace name fades only its clipped end",
  });

  const longAtDefault = readTitleState(await evalIn(app, workspaceTitleStateExpression(longName)), longName);
  expect(longAtDefault.scrollWidth).toBeGreaterThan(longAtDefault.clientWidth);
  expect(longAtDefault.maskImage).not.toBe("none");
  expectViewportSpansRow(longAtDefault, longName);
  evidence.recordAssertionEvidence(
    "A workspace name wider than the sidebar fades only its clipped end and stops before the row icons",
    `${JSON.stringify(longName)} measured ${longAtDefault.scrollWidth}px inside a ${longAtDefault.clientWidth}px viewport ending at ${longAtDefault.viewportRight.toFixed(1)}px, before the chevron at ${longAtDefault.chevronLeft?.toFixed(1) ?? "n/a"}px.`,
    true,
  );
  const shortBesideLong = readTitleState(await evalIn(app, workspaceTitleStateExpression(shortName)), shortName);
  expectFullyVisible(shortBesideLong, shortName);
  await screenshot(app);

  await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: longAtDefault.x, y: longAtDefault.y });
  await waitFor(app, `${workspaceTitleStateExpression(longName)}?.hiddenEdges === "start"`, {
    timeoutMs: 30_000,
    label: "hovered workspace name reveals its final characters",
  });
  const revealed = readTitleState(await evalIn(app, workspaceTitleStateExpression(longName)), longName);
  expect(revealed.maskImage).not.toBe("none");
  evidence.recordAssertionEvidence(
    "Hovering a clipped workspace name reveals its end, like task rows do",
    `After hovering, ${JSON.stringify(longName)} reported ${JSON.stringify(revealed.hiddenEdges)} hidden edges: the final characters are crisp and only the scrolled-away start is faded.`,
    true,
  );
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: longAtDefault.y + 200 });
  await waitFor(app, `${workspaceTitleStateExpression(longName)}?.hiddenEdges === "end"`, {
    timeoutMs: 15_000,
    label: "workspace name returns to rest after hover",
  });

  await dragRail(app, 340);
  await waitFor(app, `${workspaceTitleStateExpression(longName)}?.hiddenEdges === "none"`, {
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
