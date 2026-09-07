import assert from "node:assert/strict";
import { test } from "node:test";
import { PANEL_VIEWS, PANEL_VIEW_TITLES } from "./panel-views.ts";
import { BANNED_TOOLTIP_WORDS, TOOLTIP_GAP_PX, TOOLTIP_VIEWPORT_MARGIN_PX, panelViewTooltip, tooltipPosition } from "./tooltip.ts";

const viewport = { width: 1200, height: 800 };
const tip = { width: 200, height: 40 };

test("a tooltip sits on the asked side of its trigger, centred along it", () => {
  const trigger = { top: 300, left: 500, width: 32, height: 32 };
  assert.deepEqual(tooltipPosition(trigger, tip, "top", viewport), { top: 300 - 40 - TOOLTIP_GAP_PX, left: 500 + 16 - 100 });
  assert.deepEqual(tooltipPosition(trigger, tip, "bottom", viewport), { top: 300 + 32 + TOOLTIP_GAP_PX, left: 500 + 16 - 100 });
  assert.deepEqual(tooltipPosition(trigger, tip, "left", viewport), { top: 300 + 16 - 20, left: 500 - 200 - TOOLTIP_GAP_PX });
  assert.deepEqual(tooltipPosition(trigger, tip, "right", viewport), { top: 300 + 16 - 20, left: 500 + 32 + TOOLTIP_GAP_PX });
});

test("a tooltip never leaves the window", () => {
  // The strip icon at the right edge: a tooltip to its left still fits; one to its right is pulled back in.
  const rightEdge = { top: 40, left: 1160, width: 32, height: 32 };
  assert.equal(tooltipPosition(rightEdge, tip, "right", viewport).left, viewport.width - tip.width - TOOLTIP_VIEWPORT_MARGIN_PX);
  assert.equal(tooltipPosition(rightEdge, tip, "left", viewport).left, 1160 - 200 - TOOLTIP_GAP_PX);
  // A header control at the very top: "above" would be off screen, so it is held at the margin.
  const topEdge = { top: 4, left: 600, width: 32, height: 32 };
  assert.equal(tooltipPosition(topEdge, tip, "top", viewport).top, TOOLTIP_VIEWPORT_MARGIN_PX);
  // The far left and the very bottom are clamped the same way.
  assert.equal(tooltipPosition({ top: 790, left: 0, width: 32, height: 32 }, tip, "bottom", viewport).top, viewport.height - tip.height - TOOLTIP_VIEWPORT_MARGIN_PX);
  assert.equal(tooltipPosition({ top: 400, left: 0, width: 32, height: 32 }, tip, "top", viewport).left, TOOLTIP_VIEWPORT_MARGIN_PX);
});

test("each strip tooltip is the view's name plus one clause about what it shows, in the coworker's name", () => {
  for (const view of PANEL_VIEWS) {
    const copy = panelViewTooltip(view, "Editor");
    assert.ok(copy.startsWith(`${PANEL_VIEW_TITLES[view]} — `), copy);
    assert.equal(copy.split(" — ").length, 2, copy);
    for (const word of BANNED_TOOLTIP_WORDS) assert.ok(!new RegExp(`\\b${word}s?\\b`, "i").test(copy), `${copy} says ${word}`);
  }
  assert.equal(panelViewTooltip("overview", "Editor"), "Activity — what Editor is doing now, recently, and the assignments, Workers, and documents it holds");
  assert.equal(panelViewTooltip("memory", "Nova"), "Memory — what Nova knows and remembers");
  assert.equal(panelViewTooltip("settings", "Nova"), "Coworker settings — look, role, AI model, apps & tools, retire");
});
