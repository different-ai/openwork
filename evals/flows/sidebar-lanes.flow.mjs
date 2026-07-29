import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

/**
 * Sidebar lane system: every sidebar row lands on one of two vertical rails —
 * the 14px glyph lane (search, activity dot-matrix, chevrons, section label)
 * and the 38px label lane (search, workspace names, session titles, group
 * labels and placeholders). Regression for the ragged sidebar where the
 * section label, workspace titles and session titles each had their own left
 * edge. Lanes are defined in
 * `apps/app/src/react-app/domains/session/sidebar/sidebar-lanes.tsx`.
 */
const vo = await loadVoiceoverParagraphs("sidebar-lanes");
const GLYPH_LANE = 14;
const LABEL_LANE = 38;
const NEST_STEP = 16;
const FIXTURE_WORKSPACE = resolve(
  process.env.OPENWORK_EVAL_ARTIFACTS_DIR ?? "evals/results",
  "..",
  "sidebar-lanes-workspace",
);

const MEASURE_LANES = `(() => {
  const sidebar = document.querySelector('[data-slot="sidebar"]');
  if (!sidebar) return null;
  const round = (value) => Math.round(value * 10) / 10;
  const firstTextX = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0) return round(rect.x);
    }
    return null;
  };
  // Leading glyph only: trailing affordances (add, count, chevron) are not
  // lane-governed, so anything right of the label is ignored.
  const glyphX = (el, labelX) => {
    for (const child of el.querySelectorAll("span, svg")) {
      const rect = child.getBoundingClientRect();
      if (rect.width <= 0 || rect.width > 20 || rect.height <= 0) continue;
      if (labelX !== null && rect.x >= labelX) continue;
      return round(rect.x);
    }
    return null;
  };
  const rows = [];
  const add = (kind, el) => {
    const text = (el.innerText || "").split("\\n")[0].trim().slice(0, 24);
    if (!text) return;
    const label = firstTextX(el);
    rows.push({ kind, glyph: glyphX(el, label), label, text });
  };
  const search = sidebar.querySelector('[data-sidebar="header"] [data-sidebar="menu-button"]');
  if (search) add("search", search);
  for (const el of sidebar.querySelectorAll(".group\\\\/workspaces-header")) add("section", el);
  for (const el of sidebar.querySelectorAll('.group\\\\/workspace-header [data-sidebar="menu-button"]')) add("workspace", el);
  for (const el of sidebar.querySelectorAll("[data-session-group]")) add("group-label", el);
  for (const el of sidebar.querySelectorAll('[data-sidebar-session-id] [data-sidebar="menu-sub-button"]')) add("session", el);
  for (const el of sidebar.querySelectorAll('[data-sidebar="menu-sub-button"]')) {
    if (el.closest("[data-sidebar-session-id]")) continue;
    add("placeholder", el);
  }
  return rows;
})()`;

const EXPAND_ALL_WORKSPACES = `(() => {
  let clicked = 0;
  for (const header of document.querySelectorAll(".group\\\\/workspace-header")) {
    const toggle = header.querySelector("button.group\\\\/expand-collapse-button");
    if (toggle?.getAttribute("aria-expanded") === "false") {
      toggle.click();
      clicked += 1;
    }
  }
  return clicked;
})()`;

export default {
  id: "sidebar-lanes",
  title: "Sidebar rows align on tighter shared glyph (14px) and label (38px) lanes",
  kind: "user-facing",
  spec: "apps/app/src/react-app/ARCHITECTURE.md",
  steps: [
    {
      name: "App is ready and Electron-backed",
      run: async (ctx) => {
        await ctx.eval("location.reload()");
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
        const userAgent = await ctx.eval("navigator.userAgent");
        ctx.assert(userAgent.includes("Electron/"), `Expected Electron userAgent, got ${userAgent}`);
      },
    },
    {
      name: "A workspace with at least one session is visible in the sidebar",
      run: async (ctx) => {
        const hasSession = await ctx.eval(`document.querySelectorAll("[data-sidebar-session-id]").length > 0`);
        if (!hasSession) {
          const canCreateTask = await ctx.eval(
            "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
          );
          if (!canCreateTask) {
            await mkdir(FIXTURE_WORKSPACE, { recursive: true });
            const welcomeInput = 'input[placeholder="/workspace/my-project"]';
            const onWelcome = await ctx.eval(`Boolean(document.querySelector(${JSON.stringify(welcomeInput)}))`);
            if (onWelcome) {
              await ctx.fill(welcomeInput, FIXTURE_WORKSPACE);
              await ctx.clickText("Use this folder", { selector: "button", timeoutMs: 10_000 });
              await ctx.clickText("Skip and use the free model", { selector: "button", timeoutMs: 30_000 }).catch(() => {});
              await ctx.clickText("Skip", { selector: "button", timeoutMs: 10_000 }).catch(() => {});
              await ctx.waitFor("location.hash.includes('/workspace/')", {
                timeoutMs: 60_000,
                label: "workspace route after folder selection",
              });
              await ctx.waitFor("Boolean(window.__openworkControl)", {
                timeoutMs: 60_000,
                label: "control API after onboarding",
              });
            } else {
              await ctx.waitFor(
                "window.__openworkControl.listActions().some((action) => action.id === 'workspace.create' && !action.disabled)",
                { timeoutMs: 30_000, label: "workspace creation control" },
              );
              await ctx.control("workspace.create", { path: FIXTURE_WORKSPACE });
            }
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
              { timeoutMs: 60_000, label: "enabled task creation" },
            );
          }
          await ctx.control("session.create_task");
        }
        await ctx.eval(EXPAND_ALL_WORKSPACES);
        await ctx.waitFor(`document.querySelectorAll("[data-sidebar-session-id]").length > 0`, {
          timeoutMs: 60_000,
          label: "session rows in the sidebar",
        });
      },
    },
    {
      name: "Rows share the glyph and label lanes",
      run: async (ctx) => {
        const rows = await ctx.eval(MEASURE_LANES);
        ctx.assert(Array.isArray(rows) && rows.length > 0, "Could not measure any sidebar rows.");
        ctx.log(`Measured rows: ${JSON.stringify(rows)}`);

        const kinds = new Set(rows.map((row) => row.kind));
        ctx.assert(kinds.has("search"), "No search row was measured.");
        ctx.assert(kinds.has("workspace"), "No workspace header row was measured.");
        ctx.assert(kinds.has("session"), "No session row was measured.");

        const maxNestSteps = 6;
        const allowedGlyph = Array.from({ length: maxNestSteps + 1 }, (_, depth) => GLYPH_LANE + depth * NEST_STEP);
        const allowedLabel = Array.from({ length: maxNestSteps + 1 }, (_, depth) => LABEL_LANE + depth * NEST_STEP);
        // Section labels sit on the glyph lane (no nest).
        allowedLabel.push(GLYPH_LANE);
        const offLane = rows.filter((row) => {
          const glyphOff = row.glyph !== null && !allowedGlyph.some((lane) => Math.abs(row.glyph - lane) <= 1);
          const labelOff = row.label !== null && !allowedLabel.some((lane) => Math.abs(row.label - lane) <= 1);
          return glyphOff || labelOff;
        });

        await ctx.prove("Sidebar rows land on the two shared lanes", {
          voiceover: vo[0],
          claim:
            "Search, section labels, workspace titles, group labels, session titles and placeholders all sit on the 14px glyph lane or the 38px label lane (+16px per nesting depth).",
          assert: () => {
            ctx.assert(
              offLane.length === 0,
              `Rows off the shared lanes: ${JSON.stringify(offLane)}`,
            );
            const titles = rows.filter((row) => row.kind === "search" || row.kind === "workspace" || row.kind === "session");
            for (const row of titles) {
              const onANestLane = allowedLabel.some((lane) => lane >= LABEL_LANE && Math.abs(row.label - lane) <= 1);
              ctx.assert(
                onANestLane,
                `Title "${row.text}" starts at ${row.label}px instead of the ${LABEL_LANE}px label lane (+16px per depth).`,
              );
            }
          },
          screenshot: {
            name: "sidebar-lanes-aligned",
            requireText: ["Search sessions", "WORKSPACES"],
          },
        });
      },
    },
  ],
};
