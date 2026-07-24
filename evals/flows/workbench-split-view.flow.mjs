import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("workbench-split-view");

async function clickAt(ctx, point, button = "left") {
  await ctx.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, clickCount: 1 });
  await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, clickCount: 1 });
}

let sessionA = null;
let sessionB = null;

const CENTER_OF = (selectorExpr) => `(() => {
  const el = ${selectorExpr};
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`;

// Sidebar session rows are the vertical tabs; pill segments live inside
// [data-session-tab-split-pill] and must be excluded when picking a row.
const SIDEBAR_ROW = (sessionId) =>
  `[...document.querySelectorAll('[data-session-tab-id=${JSON.stringify(sessionId)}]')]
    .find((e) => !e.closest("[data-session-tab-split-pill]"))`;

/**
 * Vertical tab system: the sidebar is the tab list. Right-clicking a session
 * row offers "Open in split view", the active pair renders as a joined pill
 * at the top of the sidebar, and back/forward restores split state like a
 * browser history.
 */
export default {
  id: "workbench-split-view",
  title: "Vertical tabs: split view from the sidebar, history-aware",
  kind: "user-facing",
  precondition: async (ctx) => {
    await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
    const state = await ctx.waitFor(
      `(() => {
        const control = window.__openworkControl;
        const route = control.snapshot().route;
        if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
        const action = control.listActions().find((a) => a.id === "session.list_sessions");
        if (action && !action.disabled) return "ready";
        return null;
      })()`,
      { timeoutMs: 30_000, label: "session listing ready (or welcome/signin)" },
    );
    return state === "blocked"
      ? "Profile is not onboarded (welcome/signin); this flow requires a workspace."
      : null;
  },
  steps: [
    {
      name: "Right-click on a sidebar session offers Open in split view",
      run: async (ctx) => {
        // Idempotency: reset renderer state, then make sure two sessions exist.
        await ctx.eval("location.reload()");
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after reload" });
        await ctx.waitFor(
          `window.__openworkControl.listActions().some((a) => a.id === "session.list_sessions" && !a.disabled)`,
          { timeoutMs: 30_000, label: "session listing ready" },
        );
        let sessions = [];
        for (let attempt = 0; attempt < 20 && sessions.length < 2; attempt += 1) {
          sessions = (await ctx.control("session.list_sessions")) ?? [];
          if (sessions.length < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        while (sessions.length < 2) {
          await ctx.control("session.create_task");
          sessions = (await ctx.control("session.list_sessions")) ?? [];
        }
        [sessionA, sessionB] = sessions.slice(0, 2).map((s) => s.sessionId);

        // Make session A the active conversation; B stays a sidebar row.
        await ctx.control("session.open", { sessionId: sessionA });
        for (const sessionId of [sessionA, sessionB]) {
          await ctx.waitFor(`Boolean(${SIDEBAR_ROW(sessionId)})`, {
            timeoutMs: 20_000,
            label: "sidebar session row present",
          });
        }

        await ctx.prove("The sidebar session context menu offers a split view entry", {
          voiceover: vo[0],
          action: async () => {
            const point = await ctx.eval(CENTER_OF(SIDEBAR_ROW(sessionB)));
            ctx.assert(point, "No inactive sidebar session row to right-click.");
            await clickAt(ctx, point, "right");
            await ctx.waitForText("Open in split view", { timeoutMs: 10_000 });
          },
          assert: async () => {
            await ctx.expectText("Open in split view");
          },
          screenshot: {
            name: "sidebar-context-menu",
            requireText: ["Open in split view"],
          },
        });
      },
    },
    {
      name: "Choosing split shows two panes and the joined sidebar pill",
      run: async (ctx) => {
        await ctx.prove("Both sessions render side by side; the sidebar shows one joined pill", {
          voiceover: vo[1],
          action: async () => {
            const point = await ctx.eval(CENTER_OF(
              `[...document.querySelectorAll('[data-slot="context-menu-item"]')].find((e) => e.textContent.includes("Open in split view"))`,
            ));
            ctx.assert(point, "Split view menu item not found.");
            await clickAt(ctx, point);
            await ctx.waitFor(`Boolean(document.querySelector("[data-session-tab-split-pill]"))`, {
              timeoutMs: 15_000,
              label: "joined split pill",
            });
          },
          assert: async () => {
            const state = await ctx.eval(`(() => ({
              segments: document.querySelectorAll("[data-session-tab-split-pill] [data-session-tab-id]").length,
              panes: document.querySelectorAll("[data-workbench-pane]").length,
              handle: Boolean(document.querySelector('[data-slot="resizable-handle"]')),
            }))()`);
            ctx.assert(state.segments === 2, `Expected 2 pill segments, got ${state.segments}.`);
            ctx.assert(state.panes === 2, `Expected 2 panes, got ${state.panes}.`);
            ctx.assert(state.handle, "No resizable divider between the panes.");
          },
          screenshot: { name: "split-active-joined-pill" },
        });
      },
    },
    {
      name: "Back dissolves the split; forward restores the same layout",
      run: async (ctx) => {
        await ctx.prove("History navigation restores split state like a browser", {
          voiceover: vo[2],
          action: async () => {
            const back = await ctx.eval(CENTER_OF(`document.querySelector('[data-conversation-history-control="back"]')`));
            ctx.assert(back, "Back button not found in the sidebar.");
            await clickAt(ctx, back);
            await ctx.waitFor(`!document.querySelector("[data-session-tab-split-pill]")`, {
              timeoutMs: 10_000,
              label: "split dissolved after back",
            });
            const forward = await ctx.eval(CENTER_OF(`document.querySelector('[data-conversation-history-control="forward"]')`));
            ctx.assert(forward, "Forward button not found in the sidebar.");
            await clickAt(ctx, forward);
            await ctx.waitFor(`Boolean(document.querySelector("[data-session-tab-split-pill]"))`, {
              timeoutMs: 10_000,
              label: "split restored after forward",
            });
          },
          assert: async () => {
            const state = await ctx.eval(`(() => ({
              panes: document.querySelectorAll("[data-workbench-pane]").length,
              segments: document.querySelectorAll("[data-session-tab-split-pill] [data-session-tab-id]").length,
            }))()`);
            ctx.assert(state.panes === 2, `Forward should restore 2 panes, got ${state.panes}.`);
            ctx.assert(state.segments === 2, `Forward should restore the joined pill, got ${state.segments} segments.`);
          },
          screenshot: { name: "split-restored-by-forward" },
        });
      },
    },
    {
      name: "Closing a pill segment dissolves the split, keeps the sessions",
      run: async (ctx) => {
        await ctx.prove("One pane remains and both sessions stay in the sidebar", {
          voiceover: vo[3],
          action: async () => {
            const point = await ctx.eval(CENTER_OF(
              `[...document.querySelectorAll('[data-session-tab-split-pill] [data-session-tab-id]')]
                .find((e) => e.getAttribute("data-session-tab-id") === ${JSON.stringify(sessionB)})
                ?.querySelector("button[aria-label]")`,
            ));
            ctx.assert(point, "Close button on the split segment not found.");
            await clickAt(ctx, point);
            await ctx.waitFor(`!document.querySelector("[data-session-tab-split-pill]")`, {
              timeoutMs: 10_000,
              label: "split dissolved",
            });
          },
          assert: async () => {
            const state = await ctx.eval(`(() => {
              const rows = [...document.querySelectorAll("[data-session-tab-id]")]
                .filter((e) => !e.closest("[data-session-tab-split-pill]"))
                .map((e) => e.getAttribute("data-session-tab-id"));
              return {
                panes: document.querySelectorAll("[data-workbench-pane]").length,
                rows,
              };
            })()`);
            ctx.assert(state.panes === 1, `Expected 1 pane, got ${state.panes}.`);
            ctx.assert(state.rows.includes(sessionA), "Session A row missing from the sidebar.");
            ctx.assert(state.rows.includes(sessionB), "Session B row missing from the sidebar.");
          },
          screenshot: { name: "split-dissolved" },
        });
      },
    },
  ],
};
