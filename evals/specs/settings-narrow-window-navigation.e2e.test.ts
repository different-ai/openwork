import { expect } from "vitest";
import { createAndSelectWorkspace, evalIn, go, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

/**
 * Settings hides its navigation sidebar in an off-canvas sheet once the window
 * is narrower than the sidebar's mobile breakpoint. In that state the header
 * must still offer a way to reopen the sidebar and a way to leave Settings; the
 * bug this guards against hid both of those controls at a wider breakpoint than
 * the one that hides the sidebar, leaving a band of window widths where a user
 * could open Settings and then find no visible way back to the app.
 *
 * The negative half keeps the wide layout honest: once the inline sidebar with
 * its own "Back to app" entry is painted, the header controls must step aside
 * rather than duplicating it.
 */
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "Settings keeps a visible way back to the app in a narrow window"
  : "settings narrow-window navigation skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

/** Inside the range where the Settings sidebar is an off-canvas sheet. */
const narrowWidth = 900;
/** Just past the breakpoint where the inline sidebar returns. */
const wideWidth = 1100;

interface Layout {
  windowWidth: number;
  trigger: { painted: boolean; hitsSelf: boolean };
  close: { painted: boolean; hitsSelf: boolean };
  inlineSidebar: { painted: boolean; backToApp: boolean };
  headerPaddingLeft: number;
}

/**
 * Both controls exist in the DOM at every width (they are hidden with CSS), so
 * "painted" is measured, never inferred from presence. Hit-testing the center of
 * each control proves nothing is stacked over it — the traffic-light padding
 * regression put the header content under the draggable titlebar region.
 */
const layoutExpression = `(() => {
  const painted = (node) => {
    if (!(node instanceof HTMLElement)) return { painted: false, hitsSelf: false };
    const rect = node.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(node).display !== "none";
    if (!visible) return { painted: false, hitsSelf: false };
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { painted: true, hitsSelf: node.contains(hit) };
  };
  const header = document.querySelector("main > header");
  const trigger = header ? header.querySelector('[data-slot="sidebar-trigger"]') : null;
  const close = header ? header.querySelector('button[aria-label="Close settings"]') : null;
  const inline = document.querySelector('[data-slot="sidebar"][data-state]');
  const inlineRect = inline instanceof HTMLElement ? inline.getBoundingClientRect() : null;
  const inlinePainted = inlineRect !== null && inlineRect.width > 0;
  const backToApp = inlinePainted && [...inline.querySelectorAll("button")]
    .some((button) => (button.textContent ?? "").trim() === "Back to app" && button.getBoundingClientRect().width > 0);
  return {
    windowWidth: window.innerWidth,
    trigger: painted(trigger),
    close: painted(close),
    inlineSidebar: { painted: inlinePainted, backToApp },
    headerPaddingLeft: header instanceof HTMLElement ? parseFloat(getComputedStyle(header).paddingLeft) : -1,
  };
})()`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPaint(value: unknown): value is Layout["trigger"] {
  return isRecord(value) && typeof value.painted === "boolean" && typeof value.hitsSelf === "boolean";
}

function layout(value: unknown, label: string): Layout {
  if (!isRecord(value)) throw new Error(`${label} was not readable: ${JSON.stringify(value)}`);
  const { windowWidth, trigger, close, inlineSidebar, headerPaddingLeft } = value;
  if (
    typeof windowWidth !== "number" ||
    !isPaint(trigger) ||
    !isPaint(close) ||
    !isRecord(inlineSidebar) ||
    typeof inlineSidebar.painted !== "boolean" ||
    typeof inlineSidebar.backToApp !== "boolean" ||
    typeof headerPaddingLeft !== "number"
  ) {
    throw new Error(`${label} returned an unexpected shape: ${JSON.stringify(value)}`);
  }
  return {
    windowWidth,
    trigger,
    close,
    inlineSidebar: { painted: inlineSidebar.painted, backToApp: inlineSidebar.backToApp },
    headerPaddingLeft,
  };
}

async function resizeTo(app: Parameters<typeof evalIn>[0], width: number): Promise<void> {
  await app.client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // The sidebar listens to a matchMedia change and the header padding animates;
  // wait until the app reports the new width before measuring anything.
  await waitFor(app, `window.innerWidth === ${width}`, { timeoutMs: 15_000, label: `window ${width}px wide` });
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function clickCenter(app: Parameters<typeof evalIn>[0], selector: string, label: string): Promise<void> {
  const point = await evalIn(
    app,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
  );
  if (!isRecord(point) || typeof point.x !== "number" || typeof point.y !== "number") {
    throw new Error(`${label}: no element to click for ${selector} (${JSON.stringify(point)})`);
  }
  const { x, y } = point;
  await app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "settings-narrow-window-navigation" });
  const workspace = await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-settings-narrow-window-navigation-${Date.now()}`,
  });

  // Guillaume hit this on the AI Providers page, so drive that exact route.
  await resizeTo(app, narrowWidth);
  await go(app, `/workspace/${encodeURIComponent(workspace.workspaceId)}/settings/ai`);
  await waitFor(app, `window.location.hash.includes("/settings/ai") && Boolean(document.querySelector("main > header"))`, {
    timeoutMs: 60_000,
    label: "AI Providers settings page mounted",
  });
  await resizeTo(app, narrowWidth);

  const narrow = layout(await evalIn(app, layoutExpression), "narrow settings layout");
  expect(narrow.windowWidth).toBe(narrowWidth);

  // The precondition for the bug: the inline sidebar is genuinely gone, so the
  // header controls are the only navigation left on screen.
  expect(narrow.inlineSidebar.painted).toBe(false);
  evidence.recordAssertionEvidence(
    "A narrow Settings window has no inline sidebar",
    `At ${narrow.windowWidth}px the Settings sidebar is not painted inline (it is an off-canvas sheet), so the header must carry the navigation.`,
    true,
  );

  expect(narrow.trigger.painted).toBe(true);
  expect(narrow.trigger.hitsSelf).toBe(true);
  evidence.recordAssertionEvidence(
    "The sidebar trigger is visible and clickable in a narrow Settings window",
    `At ${narrow.windowWidth}px the header sidebar trigger is painted and is the topmost element at its own center.`,
    true,
  );

  expect(narrow.close.painted).toBe(true);
  expect(narrow.close.hitsSelf).toBe(true);
  evidence.recordAssertionEvidence(
    "The close button is visible and clickable in a narrow Settings window",
    `At ${narrow.windowWidth}px the "Close settings" button is painted and is the topmost element at its own center.`,
    true,
  );

  // Without the inline sidebar the header sits flush against the window edge,
  // so it must keep the wide left inset that clears the macOS window controls.
  expect(narrow.headerPaddingLeft).toBeGreaterThanOrEqual(64);
  evidence.recordAssertionEvidence(
    "The narrow Settings header keeps its window-control clearance",
    `At ${narrow.windowWidth}px the Settings header has ${narrow.headerPaddingLeft}px of left padding, at or beyond the 64px reserved for window controls.`,
    true,
  );

  // Reopening the sidebar through the trigger proves the control drives the
  // sheet rather than merely being painted.
  await clickCenter(app, 'main > header [data-slot="sidebar-trigger"]', "open settings sidebar sheet");
  await waitFor(
    app,
    `[...document.querySelectorAll('[data-slot="sidebar"] button, [role="dialog"] button')]
      .some((button) => (button.textContent ?? "").trim() === "Back to app" && button.getBoundingClientRect().width > 0)`,
    { timeoutMs: 15_000, label: "settings sidebar sheet opened" },
  );
  evidence.recordAssertionEvidence(
    "The trigger opens the Settings navigation sheet",
    `Clicking the header trigger at ${narrow.windowWidth}px opened the sheet and painted its "Back to app" entry.`,
    true,
  );
  await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor(
    app,
    `![...document.querySelectorAll('[role="dialog"] button')]
      .some((button) => (button.textContent ?? "").trim() === "Back to app" && button.getBoundingClientRect().width > 0)`,
    { timeoutMs: 15_000, label: "settings sidebar sheet closed" },
  );

  // Negative half: once the window is wide enough for the inline sidebar and
  // its own "Back to app", the header controls step aside.
  await resizeTo(app, wideWidth);
  const wide = layout(await evalIn(app, layoutExpression), "wide settings layout");
  expect(wide.windowWidth).toBe(wideWidth);
  expect(wide.inlineSidebar.painted).toBe(true);
  expect(wide.inlineSidebar.backToApp).toBe(true);
  expect(wide.trigger.painted).toBe(false);
  expect(wide.close.painted).toBe(false);
  evidence.recordAssertionEvidence(
    "A wide Settings window uses the inline sidebar instead of the header controls",
    `At ${wide.windowWidth}px the inline sidebar is painted with "Back to app", and the header trigger and close button are not painted.`,
    true,
  );

  // Back to the failing width: the close button must actually leave Settings,
  // which is the gesture the reporter could not perform.
  await resizeTo(app, narrowWidth);
  await clickCenter(app, 'main > header button[aria-label="Close settings"]', "close settings");
  await waitFor(app, `!window.location.hash.includes("/settings")`, {
    timeoutMs: 30_000,
    label: "left Settings",
  });
  const routeAfterClose = await evalIn(app, `window.location.hash`);
  evidence.recordAssertionEvidence(
    "The close button leaves Settings from a narrow window",
    `Clicking "Close settings" at ${narrowWidth}px navigated away from Settings (route now ${JSON.stringify(routeAfterClose)}).`,
    true,
  );
});
