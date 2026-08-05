async function pressCommandK(ctx) {
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    modifiers: 2,
  });
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "k",
    code: "KeyK",
    windowsVirtualKeyCode: 75,
    modifiers: 2,
  });
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "k",
    code: "KeyK",
    windowsVirtualKeyCode: 75,
    modifiers: 2,
  });
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
  });
}

async function clickCommandItem(ctx, text) {
  await ctx.waitFor(
    `(() => [...document.querySelectorAll('[data-slot="command-item"]')].some((el) => (el.textContent ?? '').includes(${JSON.stringify(text)})))()`,
    { label: `command item ${text}` },
  );
  const clicked = await ctx.eval(`(() => {
    const item = [...document.querySelectorAll('[data-slot="command-item"]')]
      .find((el) => (el.textContent ?? '').includes(${JSON.stringify(text)}));
    if (!item) return false;
    item.scrollIntoView({ block: 'center' });
    item.click();
    return true;
  })()`);
  ctx.assert(clicked === true, `Could not click command item: ${text}`);
}

function routeSessionId(route) {
  const match = new RegExp("session/([^/?#]+)").exec(route);
  return match ? decodeURIComponent(match[1]) : null;
}

export default {
  id: "session-tab-navigation",
  title: "Cmd/Ctrl+T and Cmd/Ctrl+Shift+T switch session tabs",
  spec: "Keyboard shortcuts and command palette items navigate between sessions in the current workspace",
  steps: [
    {
      name: "Electron app and control API are ready",
      run: async (ctx) => {
        const userAgent = await ctx.eval("navigator.userAgent");
        ctx.assert(
          typeof userAgent === "string" && userAgent.includes("Electron/"),
          `Expected Electron userAgent, got: ${userAgent}`,
        );
        await ctx.waitFor("Boolean(window.__micxControl)", {
          timeoutMs: 60_000,
          label: "control API",
        });
        await ctx.waitFor(
          "window.__micxControl.listActions().some((a) => a.id === 'session.create_task' && !a.disabled)",
          { timeoutMs: 60_000, label: "enabled task creation action" },
        );
      },
    },
    {
      name: "Create two sessions in the current workspace",
      run: async (ctx) => {
        await ctx.control("session.create_task");
        const sessionA = await ctx.waitFor(
          `(() => {
            const route = window.__micxControl.snapshot().route;
            const match = new RegExp('session/([^/?#]+)').exec(route);
            return match ? { route, sessionId: decodeURIComponent(match[1]) } : null;
          })()`,
          { timeoutMs: 30_000, label: "session A route" },
        );
        ctx.assert(sessionA.sessionId, "No session A id after first create_task");
        ctx.log(`Session A: ${sessionA.sessionId}`);

        await ctx.control("session.create_task");
        const sessionB = await ctx.waitFor(
          `(() => {
            const route = window.__micxControl.snapshot().route;
            const match = new RegExp('session/([^/?#]+)').exec(route);
            if (!match) return null;
            const sessionId = decodeURIComponent(match[1]);
            return sessionId !== ${JSON.stringify(sessionA.sessionId)} ? { route, sessionId } : null;
          })()`,
          { timeoutMs: 30_000, label: "session B route (different from A)" },
        );
        ctx.assert(sessionB.sessionId, "No session B id after second create_task");
        ctx.log(`Session B: ${sessionB.sessionId}`);

        ctx.sessionAId = sessionA.sessionId;
        ctx.sessionBId = sessionB.sessionId;
        await ctx.screenshot("two-sessions-created", {
          claim: "Two sessions created, currently on session B",
        });
      },
    },
    {
      name: "Ctrl+Shift+T navigates to the previous session",
      run: async (ctx) => {
        const targetId = ctx.sessionAId;
        const changed = await ctx.eval(
          `(async () => {
            for (let i = 0; i < 60; i++) {
              window.dispatchEvent(new KeyboardEvent('keydown', {
                key: 't', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true
              }));
              await new Promise(r => setTimeout(r, 500));
              const route = window.__micxControl?.snapshot()?.route ?? '';
              if (new RegExp('session/' + ${JSON.stringify(targetId)} + '([/?#]|$)').test(route)) return true;
            }
            return false;
          })()`,
          { awaitPromise: true },
        );
        ctx.assert(changed === true, `Ctrl+Shift+T did not navigate to session A (${targetId})`);
        ctx.log(`Ctrl+Shift+T navigated to session A: ${targetId}`);
        await ctx.screenshot("ctrl-shift-t-previous", {
          claim: "Ctrl+Shift+T navigated to the previous session",
        });
      },
    },
    {
      name: "Ctrl+T navigates to the next session",
      run: async (ctx) => {
        const targetId = ctx.sessionBId;
        const changed = await ctx.eval(
          `(async () => {
            for (let i = 0; i < 60; i++) {
              window.dispatchEvent(new KeyboardEvent('keydown', {
                key: 't', ctrlKey: true, bubbles: true, cancelable: true
              }));
              await new Promise(r => setTimeout(r, 500));
              const route = window.__micxControl?.snapshot()?.route ?? '';
              if (new RegExp('session/' + ${JSON.stringify(targetId)} + '([/?#]|$)').test(route)) return true;
            }
            return false;
          })()`,
          { awaitPromise: true },
        );
        ctx.assert(changed === true, `Ctrl+T did not navigate to session B (${targetId})`);
        ctx.log(`Ctrl+T navigated to session B: ${targetId}`);
        await ctx.screenshot("ctrl-t-next", {
          claim: "Ctrl+T navigated to the next session",
        });
      },
    },
    {
      name: "Command palette shows tab items and Previous navigates back",
      run: async (ctx) => {
        const routeBefore = await ctx.eval("window.__micxControl.snapshot().route");
        const matchBefore = new RegExp("session/([^/?#]+)").exec(routeBefore);
        const sessionIdBefore = matchBefore ? decodeURIComponent(matchBefore[1]) : null;
        ctx.assert(sessionIdBefore, "No current session before palette click");

        await pressCommandK(ctx);
        await ctx.waitForText("Next session tab", { timeoutMs: 15_000 });
        await ctx.waitForText("Previous session tab", { timeoutMs: 5_000 });
        const body = await ctx.eval("document.body.innerText");
        ctx.assert(body.includes("Next session tab"), "Command palette missing 'Next session tab'");
        ctx.assert(body.includes("Previous session tab"), "Command palette missing 'Previous session tab'");
        await ctx.screenshot("command-palette-tab-items", {
          claim: "Command palette lists Next and Previous session tab items",
          requireText: ["Next session tab", "Previous session tab"],
        });

        await clickCommandItem(ctx, "Previous session tab");
        const changed = await ctx.waitFor(
          `(() => {
            const route = window.__micxControl.snapshot().route;
            const match = new RegExp('session/([^/?#]+)').exec(route);
            if (!match) return false;
            const sessionId = decodeURIComponent(match[1]);
            return sessionId !== ${JSON.stringify(sessionIdBefore)};
          })()`,
          { timeoutMs: 15_000, label: "route changed to a different session" },
        );
        ctx.assert(changed === true, "Previous session tab command did not change the route");
        ctx.log(`Palette 'Previous session tab' navigated away from ${sessionIdBefore}`);
        await ctx.screenshot("palette-previous-session-tab", {
          claim: "Previous session tab command navigated to a different session",
        });
      },
    },
  ],
};
