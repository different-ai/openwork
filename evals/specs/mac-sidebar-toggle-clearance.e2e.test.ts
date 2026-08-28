import { expect } from "vitest";
import { createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

/**
 * On macOS the show/hide sidebar toggle is not in the header flow: it floats in
 * the draggable titlebar, absolutely positioned clear of the native window
 * controls. That makes its left offset load-bearing in two directions at once —
 * too far left and the traffic lights sit on top of it, too far right and it
 * lands on the session title that the collapsed header reserves space for.
 *
 * The `mac:` Tailwind variant only resolves under
 * `html.openwork-electron.openwork-platform-mac`, which the Electron preload
 * adds solely when `process.platform === "darwin"`. On any other platform the
 * floating toggle is `display: none` and every claim below would pass
 * vacuously, so this spec refuses to run there rather than reporting a green
 * tape that observed nothing.
 */
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const onMac = process.platform === "darwin";
const enabled = e2eTestsEnabled && onMac;
const title = enabled
  ? "the macOS titlebar sidebar toggle clears the window controls and never collides with the session title"
  : e2eTestsEnabled
    ? `mac sidebar toggle clearance skipped — needs: run on macOS (mac: variant inert on ${process.platform})`
    : "mac sidebar toggle clearance skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

/** Clearance the toggle must keep from the window's left edge, in CSS px. */
const requiredLeftClearance = 88;

/**
 * Breathing room the toggle must leave between its right edge and the session
 * title once the sidebar is collapsed. The collapsed header reserves padding
 * for this floating button; if that reservation is not kept in step with the
 * button's own offset the two end up flush (measured 1px apart) or overlapping
 * outright at widths where the button grows to 44px.
 */
const requiredTitleClearance = 16;

const sidebarStateExpression = `document.querySelector('[data-slot="sidebar"][data-state]')?.getAttribute("data-state") ?? ""`;

const titleLeftExpression = `(() => {
  const heading = document.querySelector("header h1");
  return heading instanceof HTMLElement ? heading.getBoundingClientRect().left : -1;
})()`;

/**
 * The non-mac trigger is still in the DOM (hidden via `mac:hidden`), so pick the
 * trigger that is actually painted rather than the first one that matches.
 */
const geometryExpression = `(() => {
  const triggers = [...document.querySelectorAll('[data-slot="sidebar-trigger"]')];
  const toggle = triggers.find((node) => {
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).display !== "none";
  });
  if (!(toggle instanceof HTMLElement)) return { found: false };
  const heading = document.querySelector("header h1");
  const toggleRect = toggle.getBoundingClientRect();
  const headingRect = heading instanceof HTMLElement ? heading.getBoundingClientRect() : null;
  const hit = document.elementFromPoint(
    toggleRect.left + toggleRect.width / 2,
    toggleRect.top + toggleRect.height / 2,
  );
  return {
    found: true,
    position: getComputedStyle(toggle).position,
    left: toggleRect.left,
    right: toggleRect.right,
    width: toggleRect.width,
    height: toggleRect.height,
    headingLeft: headingRect ? headingRect.left : null,
    headingText: heading instanceof HTMLElement ? (heading.textContent ?? "").trim() : "",
    overlapsHeading: headingRect ? toggleRect.right > headingRect.left : false,
    hitsToggle: toggle.contains(hit),
    hitTag: hit instanceof Element ? hit.tagName.toLowerCase() : "",
  };
})()`;

interface Geometry {
  found: boolean;
  position: string;
  left: number;
  right: number;
  width: number;
  height: number;
  headingLeft: number | null;
  headingText: string;
  overlapsHeading: boolean;
  hitsToggle: boolean;
  hitTag: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function geometry(value: unknown, label: string): Geometry {
  if (!isRecord(value)) throw new Error(`${label} was not readable: ${JSON.stringify(value)}`);
  if (value.found !== true) throw new Error(`${label} found no painted sidebar toggle: ${JSON.stringify(value)}`);
  const { position, left, right, width, height, headingLeft, headingText, overlapsHeading, hitsToggle, hitTag } = value;
  if (
    typeof position !== "string" ||
    typeof left !== "number" ||
    typeof right !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    typeof headingText !== "string" ||
    typeof overlapsHeading !== "boolean" ||
    typeof hitsToggle !== "boolean" ||
    typeof hitTag !== "string" ||
    !(headingLeft === null || typeof headingLeft === "number")
  ) {
    throw new Error(`${label} returned an unexpected shape: ${JSON.stringify(value)}`);
  }
  return { found: true, position, left, right, width, height, headingLeft, headingText, overlapsHeading, hitsToggle, hitTag };
}

/**
 * `data-state` flips the instant the sidebar is toggled, but the header animates
 * its reserved padding over 200ms, so the state change alone still reads the
 * outgoing layout. Hold until the title has held one position for consecutive
 * samples. Deliberately keeps no state between calls: an earlier version cached
 * the baseline on `window` and reported "settled" immediately whenever the first
 * sample of a new wait happened to match the previous wait's resting value.
 */
async function waitForTitleSettled(app: Parameters<typeof evalIn>[0], label: string): Promise<number> {
  const read = async (): Promise<number> => {
    const value = await evalIn(app, titleLeftExpression);
    if (typeof value !== "number" || value < 0) throw new Error(`${label}: no session title to measure (${JSON.stringify(value)})`);
    return value;
  };
  const stepMs = 120;
  const requiredStableMs = 360;
  const deadline = Date.now() + 15_000;
  let previous = await read();
  let stableMs = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    const next = await read();
    if (next === previous) {
      stableMs += stepMs;
      if (stableMs >= requiredStableMs) return next;
      continue;
    }
    stableMs = 0;
    previous = next;
  }
  throw new Error(`${label}: the session title never stopped moving (last seen at ${previous}px).`);
}

async function setSidebar(app: Parameters<typeof evalIn>[0], want: "expanded" | "collapsed"): Promise<void> {
  const current = await evalIn(app, sidebarStateExpression);
  if (current === want) return;
  const point = geometry(await evalIn(app, geometryExpression), "sidebar toggle");
  const x = point.left + (point.right - point.left) / 2;
  const y = await evalIn(
    app,
    `(() => {
      const triggers = [...document.querySelectorAll('[data-slot="sidebar-trigger"]')];
      const toggle = triggers.find((node) => node instanceof HTMLElement && node.getBoundingClientRect().width > 0);
      if (!(toggle instanceof HTMLElement)) return 0;
      const rect = toggle.getBoundingClientRect();
      return rect.top + rect.height / 2;
    })()`,
  );
  if (typeof y !== "number" || y <= 0) throw new Error(`Could not resolve the toggle's vertical center: ${String(y)}`);
  await app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await waitFor(app, `(${sidebarStateExpression}) === ${JSON.stringify(want)}`, {
    timeoutMs: 15_000,
    label: `sidebar ${want}`,
  });
  await waitForTitleSettled(app, `sidebar ${want}`);
}

test.skipIf(!enabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "mac-sidebar-toggle-clearance" });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-mac-sidebar-toggle-clearance-${Date.now()}`,
  });

  await waitFor(app, `Boolean(document.querySelector('[data-slot="sidebar-trigger"]'))`, {
    timeoutMs: 60_000,
    label: "sidebar toggle mounted",
  });
  await waitFor(app, `Boolean(document.querySelector('header h1'))`, {
    timeoutMs: 60_000,
    label: "session header title mounted",
  });
  await waitForTitleSettled(app, "boot");

  // The floating mac toggle is the one under test. If the platform variant did
  // not resolve we would silently be measuring the in-flow Windows/Linux
  // button, so pin that down before asserting anything about clearance.
  const expanded = geometry(await evalIn(app, geometryExpression), "sidebar toggle while expanded");
  expect(expanded.position).toBe("absolute");

  expect(expanded.left).toBeGreaterThanOrEqual(requiredLeftClearance);
  evidence.recordAssertionEvidence(
    "The macOS sidebar toggle sits clear of the native window controls",
    `The painted toggle is absolutely positioned in the titlebar with its left edge at ${expanded.left}px, at or beyond the ${requiredLeftClearance}px traffic-light clearance.`,
    true,
  );

  // Compact desktop widths apply a generic 44px touch target to sidebar
  // triggers. The floating macOS titlebar control must remain the native-sized
  // 32px variant or it crowds the session title despite keeping the same left
  // offset.
  await app.client.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitForTitleSettled(app, "compact desktop width");
  const compact = geometry(await evalIn(app, geometryExpression), "sidebar toggle at compact desktop width");
  expect(compact.width).toBe(32);
  expect(compact.height).toBe(32);
  evidence.recordAssertionEvidence(
    "The macOS titlebar toggle stays compact at narrower desktop widths",
    `At 900px wide the painted titlebar toggle remains ${compact.width}×${compact.height}px instead of inheriting the generic enlarged touch target.`,
    true,
  );

  await setSidebar(app, "collapsed");
  const collapsed = geometry(await evalIn(app, geometryExpression), "sidebar toggle while collapsed");

  // Collapsing the sidebar is what pulls the session title leftwards to the
  // padding the header reserves for this button, so it is the only state where
  // the two can crowd each other.
  expect(collapsed.overlapsHeading).toBe(false);
  expect(collapsed.headingText.length).toBeGreaterThan(0);
  if (collapsed.headingLeft === null) throw new Error("The collapsed session header exposed no title to measure against.");
  const titleClearance = collapsed.headingLeft - collapsed.right;
  expect(titleClearance).toBeGreaterThanOrEqual(requiredTitleClearance);
  evidence.recordAssertionEvidence(
    "Collapsing the sidebar leaves the session title clear of the toggle",
    `With the sidebar collapsed the toggle ends at ${collapsed.right}px and the title ${JSON.stringify(collapsed.headingText)} starts at ${collapsed.headingLeft}px — ${titleClearance}px of clearance, at or beyond the ${requiredTitleClearance}px minimum.`,
    true,
  );

  expect(collapsed.hitsToggle).toBe(true);
  evidence.recordAssertionEvidence(
    "The toggle stays the topmost click target once the sidebar is collapsed",
    `elementFromPoint at the toggle's center hit the toggle itself (node=${collapsed.hitTag}) rather than the header or title beneath it.`,
    true,
  );

  // Reopening through the same button proves the geometry above belongs to a
  // control that still works, not merely a well-placed rectangle.
  await setSidebar(app, "expanded");
  const reopened = await evalIn(app, sidebarStateExpression);
  expect(reopened).toBe("expanded");
  evidence.recordAssertionEvidence(
    "Clicking the cleared toggle still shows and hides the sidebar",
    `Clicking the floating toggle drove the sidebar collapsed and back to ${JSON.stringify(reopened)}.`,
    true,
  );

  // Thin/custom shells can intentionally remove the sidebar and therefore the
  // floating toggle. Their title still needs the same traffic-light clearance.
  await evalIn(
    app,
    `(() => {
      const key = "openwork.shell-config";
      const current = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...current, sidebar: false }));
      location.reload();
      return true;
    })()`,
  ).catch(() => undefined);
  await waitFor(app, `Boolean(document.querySelector("header h1"))`, {
    timeoutMs: 60_000,
    label: "session header restored without sidebar",
  });
  await waitForTitleSettled(app, "sidebar hidden");
  const titleWithoutSidebar = await evalIn(app, titleLeftExpression);
  if (typeof titleWithoutSidebar !== "number") throw new Error("The sidebar-free title had no measurable position.");
  expect(titleWithoutSidebar).toBeGreaterThanOrEqual(136);
  evidence.recordAssertionEvidence(
    "Sidebar-free macOS shells keep titles clear of the traffic lights",
    `With the sidebar and floating toggle disabled, the session title starts at ${titleWithoutSidebar}px, beyond the 136px reserved titlebar area.`,
    true,
  );
});
