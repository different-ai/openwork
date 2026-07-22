import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const RUN_SUFFIX = Date.now().toString().slice(-5);
const FIRST_TITLE = `Pinned alpha ${RUN_SUFFIX}`;
const SECOND_TITLE = `Pinned beta ${RUN_SUFFIX}`;
const FIRST_WORKSPACE = resolve(
  process.env.OPENWORK_EVAL_ARTIFACTS_DIR ?? "evals/results",
  "..",
  `global-pinning-alpha-${RUN_SUFFIX}`,
);
const SECOND_WORKSPACE = resolve(
  process.env.OPENWORK_EVAL_ARTIFACTS_DIR ?? "evals/results",
  "..",
  `global-pinning-beta-${RUN_SUFFIX}`,
);

async function currentSessionId(ctx) {
  return ctx.waitFor(`(() => {
    const match = /session\\/([^/?#]+)/.exec(window.__openworkControl.snapshot().route);
    return match ? decodeURIComponent(match[1]) : null;
  })()`, { timeoutMs: 30_000, label: "current session" });
}

async function finishOnboarding(ctx) {
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
  await mkdir(FIRST_WORKSPACE, { recursive: true });

  const welcomeInput = 'input[placeholder="/workspace/my-project"]';
  const onWelcome = await ctx.eval(`Boolean(document.querySelector(${JSON.stringify(welcomeInput)}))`);
  if (onWelcome) {
    await ctx.fill(welcomeInput, FIRST_WORKSPACE);
    await ctx.clickText("Use this folder", { selector: "button", timeoutMs: 10_000 });
    await ctx.clickText("Skip and use the free model", { selector: "button", timeoutMs: 30_000 }).catch(() => {});
    await ctx.clickText("Skip", { selector: "button", timeoutMs: 10_000 }).catch(() => {});
  }

  await ctx.waitFor(
    "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
    { timeoutMs: 60_000, label: "enabled task creation" },
  );
}

async function createNamedSession(ctx, title) {
  await ctx.control("session.create_task");
  const sessionId = await currentSessionId(ctx);
  await ctx.waitFor(
    "window.__openworkControl.listActions().some((action) => action.id === 'session.rename' && !action.disabled)",
    { timeoutMs: 30_000, label: "enabled session rename" },
  );
  await ctx.control("session.rename", { sessionId, title });
  await ctx.waitFor(
    `document.body.textContent.includes(${JSON.stringify(title)})`,
    { timeoutMs: 30_000, label: `visible session ${title}` },
  );
  return sessionId;
}

export default {
  id: "global-session-pinning",
  title: "Pinned sessions stay globally accessible across workspaces",
  kind: "user-facing",
  steps: [
    {
      name: "Pin sessions from two workspaces globally",
      run: async (ctx) => {
        await finishOnboarding(ctx);
        const firstSessionId = await createNamedSession(ctx, FIRST_TITLE);
        await ctx.control("session.pin", { sessionId: firstSessionId });

        await mkdir(SECOND_WORKSPACE, { recursive: true });
        await ctx.control("workspace.create", { path: SECOND_WORKSPACE, projectLabel: `Beta ${RUN_SUFFIX}` });
        await ctx.waitFor(
          "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
          { timeoutMs: 60_000, label: "second workspace task creation" },
        );
        const secondSessionId = await createNamedSession(ctx, SECOND_TITLE);
        await ctx.control("session.pin", { sessionId: secondSessionId });

        await ctx.waitFor(`(() => {
          const pinned = document.querySelector('[data-global-pinned-sessions]');
          return pinned?.textContent?.includes(${JSON.stringify(FIRST_TITLE)}) &&
            pinned.textContent.includes(${JSON.stringify(SECOND_TITLE)});
        })()`, { timeoutMs: 30_000, label: "both globally pinned sessions" });

        const counts = await ctx.eval(`({
          first: document.querySelectorAll(${JSON.stringify(`span[title^="${FIRST_TITLE}"]`)}).length,
          second: document.querySelectorAll(${JSON.stringify(`span[title^="${SECOND_TITLE}"]`)}).length,
          globalSections: document.querySelectorAll('[data-global-pinned-sessions]').length,
        })`);
        ctx.assert(counts.globalSections === 1, `Expected one global pinned section, got ${counts.globalSections}`);
        ctx.assert(counts.first === 1, `Expected ${FIRST_TITLE} once, got ${counts.first}`);
        ctx.assert(counts.second === 1, `Expected ${SECOND_TITLE} once, got ${counts.second}`);

        await ctx.control("session.pin", { sessionId: firstSessionId });
        await ctx.waitFor(`(() => {
          const pinned = document.querySelector('[data-global-pinned-sessions]');
          return !pinned?.textContent?.includes(${JSON.stringify(FIRST_TITLE)}) &&
            document.body.textContent.includes(${JSON.stringify(FIRST_TITLE)});
        })()`, { timeoutMs: 30_000, label: "unpinned session returned to its workspace" });
      },
    },
  ],
};
