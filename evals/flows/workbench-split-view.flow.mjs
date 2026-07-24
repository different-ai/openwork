import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("workbench-split-view");

async function clickAt(ctx, point, button = "left") {
  await ctx.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, clickCount: 1 });
  await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, clickCount: 1 });
}

const CENTER_OF = (selectorExpr) => `(() => {
  const el = ${selectorExpr};
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`;

/**
 * Arc-style workbench: tab context menu -> "New Split View with Current
 * Tab", joined pill in the tab strip, draggable divider, and closing a
 * segment dissolving the split while keeping both tabs.
 */
export default {
  id: "workbench-split-view",
  title: "Split view via tab context menu, joined pill, resizable panes",
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
      name: "Right-click on a tab offers New Split View with Current Tab",
      run: async (ctx) => {
        // Idempotency: reset renderer state, then open two sessions as tabs.
        await ctx.eval("location.reload()");
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after reload" });
        await ctx.waitFor(
          `window.__openworkControl.listActions().some((a) => a.id === "session.list_sessions" && !a.disabled)`,
          { timeoutMs: 30_000, label: "session listing ready" },
        );
        // The list streams in after boot; poll until two sessions exist and
        // create fresh tasks if the workspace has fewer.
        let sessions = [];
        for (let attempt = 0; attempt < 20 && sessions.length < 2; attempt += 1) {
          sessions = (await ctx.control("session.list_sessions")) ?? [];
          if (sessions.length < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        while (sessions.length < 2) {
          await ctx.control("session.create_task");
          sessions = (await ctx.control("session.list_sessions")) ?? [];
        }
        const ids = sessions.slice(0, 2).map((s) => s.sessionId);
        for (const sessionId of ids) {
          await ctx.control("session.open", { sessionId });
          await ctx.waitFor(
            `Boolean(document.querySelector('[data-session-tab-id=${JSON.stringify(sessionId)}]'))`,
            { timeoutMs: 20_000, label: "session tab present" },
          );
        }

        await ctx.prove("The tab context menu offers a split view entry", {
          voiceover: vo[0],
          action: async () => {
            const point = await ctx.eval(CENTER_OF(
              `[...document.querySelectorAll("[data-session-tab-id]")].find((e) => !e.dataset.sessionTabActive)`,
            ));
            ctx.assert(point, "No inactive session tab to right-click.");
            await clickAt(ctx, point, "right");
            await ctx.waitForText("New Split View with Current Tab", { timeoutMs: 10_000 });
          },
          assert: async () => {
            await ctx.expectText("New Split View with Current Tab");
            await ctx.expectText("Close Tab");
          },
          screenshot: {
            name: "tab-context-menu",
            requireText: ["New Split View with Current Tab", "Close Tab"],
          },
        });
      },
    },
    {
      name: "Choosing split shows two panes and the joined pill",
      run: async (ctx) => {
        await ctx.prove("Both sessions render side by side; the strip shows one joined pill", {
          voiceover: vo[1],
          action: async () => {
            const point = await ctx.eval(CENTER_OF(
              `[...document.querySelectorAll('[data-slot="context-menu-item"]')].find((e) => e.textContent.includes("New Split View"))`,
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
      name: "The divider drags to resize the panes",
      run: async (ctx) => {
        await ctx.prove("Dragging the divider changes the pane widths", {
          voiceover: vo[2],
          action: async () => {
            const handle = await ctx.eval(CENTER_OF(`document.querySelector('[data-slot="resizable-handle"]')`));
            ctx.assert(handle, "Resizable divider not found.");
            await ctx.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1 });
            for (let dx = 0; dx <= 150; dx += 30) {
              await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x - dx, y: handle.y, button: "left" });
            }
            await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x - 150, y: handle.y, button: "left", clickCount: 1 });
          },
          assert: async () => {
            const widths = await ctx.eval(`(() => {
              const primary = document.querySelector('[data-workbench-pane="primary"]').getBoundingClientRect().width;
              const secondary = document.querySelector('[data-workbench-pane="secondary"]').getBoundingClientRect().width;
              return { primary: Math.round(primary), secondary: Math.round(secondary) };
            })()`);
            ctx.assert(
              widths.secondary > widths.primary + 60,
              `Drag did not resize: primary ${widths.primary}px vs secondary ${widths.secondary}px.`,
            );
            ctx.log(`pane widths after drag: ${JSON.stringify(widths)}`);
          },
          screenshot: { name: "split-resized" },
        });
      },
    },
    {
      name: "Closing a pill segment dissolves the split, keeps the tabs",
      run: async (ctx) => {
        await ctx.prove("One pane remains and both sessions stay open as tabs", {
          voiceover: vo[3],
          action: async () => {
            const point = await ctx.eval(CENTER_OF(
              `[...document.querySelectorAll('[data-session-tab-split-pill] [data-session-tab-id]')]
                .find((e) => !e.dataset.sessionTabActive)
                ?.querySelector('button[aria-label="Close split pane"]')`,
            ));
            ctx.assert(point, "Close button on the split segment not found.");
            await clickAt(ctx, point);
            await ctx.waitFor(`!document.querySelector("[data-session-tab-split-pill]")`, {
              timeoutMs: 10_000,
              label: "split dissolved",
            });
          },
          assert: async () => {
            const state = await ctx.eval(`(() => ({
              panes: document.querySelectorAll("[data-workbench-pane]").length,
              tabs: document.querySelectorAll("[data-session-tab-id]").length,
            }))()`);
            ctx.assert(state.panes === 1, `Expected 1 pane, got ${state.panes}.`);
            ctx.assert(state.tabs === 2, `Expected both tabs to survive, got ${state.tabs}.`);
          },
          screenshot: { name: "split-dissolved" },
        });
      },
    },
  ],
};
