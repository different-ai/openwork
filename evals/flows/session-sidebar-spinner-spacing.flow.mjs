import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("session-sidebar-spinner-spacing");
const LONG_TITLE = "OpenWork diagnostics authorization with a deliberately long session title";
const FIXTURE_WORKSPACE = resolve(
  process.env.OPENWORK_EVAL_ARTIFACTS_DIR ?? "evals/results",
  "..",
  "session-sidebar-spinner-workspace",
);

const MEASURE_SESSION_ROW = `(() => {
  const title = document.querySelector(${JSON.stringify(`span[title="${LONG_TITLE}"]`)});
  const row = title?.closest('[data-sidebar="menu-sub-button"]');
  const indicator = row?.parentElement?.querySelector('[aria-label="Thinking"]');
  if (!title || !row || !indicator) return null;
  const titleRect = title.getBoundingClientRect();
  const indicatorRect = indicator.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const style = getComputedStyle(title);
  const rowStyle = getComputedStyle(row);
  return {
    titleClientWidth: title.clientWidth,
    titleScrollWidth: title.scrollWidth,
    whiteSpace: style.whiteSpace,
    overflow: style.overflow,
    textOverflow: style.textOverflow,
    titleRight: Math.round(titleRect.right),
    indicatorLeft: Math.round(indicatorRect.left),
    rowRight: Math.round(rowRect.right),
    rowPaddingInlineEnd: rowStyle.paddingInlineEnd,
    rowClassName: row.className,
    overlap: titleRect.right > indicatorRect.left,
  };
})()`;

export default {
  id: "session-sidebar-spinner-spacing",
  title: "Long active session titles truncate before the activity spinner",
  kind: "user-facing",
  steps: [
    {
      name: "Long active session title remains readable without spinner overlap",
      run: async (ctx) => {
        await ctx.eval("location.reload()");
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
        const choosingModel = await ctx.hasText("Skip and use the free model");
        if (choosingModel) {
          await ctx.clickText("Skip and use the free model", { selector: "button", timeoutMs: 10_000 });
        }
        const surveySkip = await ctx.eval(`Boolean([...document.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === 'Skip'))`);
        if (surveySkip) await ctx.clickText("Skip", { selector: "button", timeoutMs: 10_000 });
        if (choosingModel || surveySkip) {
          await ctx.waitFor("location.hash.includes('/workspace/')", { timeoutMs: 60_000, label: "workspace after onboarding" });
          await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after onboarding" });
        }
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
          } else {
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((action) => action.id === 'workspace.create' && !action.disabled)",
              { timeoutMs: 30_000, label: "workspace creation control" },
            );
            await ctx.control("workspace.create", { path: FIXTURE_WORKSPACE });
          }
        }
        await ctx.waitFor(
          "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
          { timeoutMs: 60_000, label: "enabled task creation" },
        );

        await ctx.control("session.create_task");
        const sessionId = await ctx.waitFor(`(() => {
          const match = /session\\/([^/?#]+)/.exec(window.__openworkControl.snapshot().route);
          return match ? decodeURIComponent(match[1]) : null;
        })()`, { timeoutMs: 30_000, label: "created session" });
        await ctx.waitFor(
          "window.__openworkControl.listActions().some((action) => action.id === 'session.rename' && !action.disabled)",
          { timeoutMs: 30_000, label: "enabled session rename" },
        );
        await ctx.control("session.rename", { sessionId, title: LONG_TITLE });
        await ctx.control("eval.session_sidebar.seed_active");
        await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 400 });
        await ctx.waitFor(`${MEASURE_SESSION_ROW}?.titleScrollWidth > ${MEASURE_SESSION_ROW}?.titleClientWidth`, {
          timeoutMs: 30_000,
          label: "truncated active session title",
        });

        await ctx.prove("A long active session title truncates before its spinner", {
          voiceover: vo[0],
          assert: async () => {
            const metrics = await ctx.eval(MEASURE_SESSION_ROW);
            ctx.assert(metrics, "Could not measure the active session row.");
            ctx.assert(metrics.whiteSpace === "nowrap", `Expected nowrap, got ${metrics.whiteSpace}.`);
            ctx.assert(metrics.overflow === "hidden", `Expected hidden overflow, got ${metrics.overflow}.`);
            ctx.assert(metrics.textOverflow === "ellipsis", `Expected ellipsis, got ${metrics.textOverflow}.`);
            ctx.assert(metrics.titleScrollWidth > metrics.titleClientWidth, "The long title was not truncated.");
            ctx.assert(!metrics.overlap, `Title and spinner overlap: ${JSON.stringify(metrics)}.`);
          },
          screenshot: {
            name: "session-title-truncates-before-spinner",
            requireText: ["OpenWork diagnostics authorization"],
          },
        });
      },
    },
  ],
};
