import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("side-panel-not-restored-on-load");

const EXTENSIONS_TOGGLE = 'button[aria-label="Extensions"][aria-pressed]';
const EXTENSIONS_MARKER = "Extensions (Legacy)";
const UI_STATE_KEY = "openwork:ui-state:v1";

async function waitForControl(ctx, label = "control API") {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label,
  });
}

async function waitForRenderedBody(ctx) {
  await ctx.waitFor("document.body.innerText.trim().length > 40", {
    label: "rendered body text",
  });
}

async function waitForActiveSessionId(ctx) {
  return ctx.waitFor(
    `(() => {
      const route = window.__openworkControl.snapshot().route || "";
      const match = route.match(/ses_[A-Za-z0-9]+/);
      return match ? match[0] : null;
    })()`,
    { timeoutMs: 30_000, label: "active session id in route" },
  );
}

async function readRouteSessionId(ctx) {
  return ctx.eval(`(() => {
    const route = window.__openworkControl.snapshot().route || "";
    const match = route.match(/ses_[A-Za-z0-9]+/);
    return match ? match[0] : null;
  })()`);
}

async function readExtensionsToggle(ctx) {
  return ctx.eval(`(() => {
    const toggle = document.querySelector(${JSON.stringify(EXTENSIONS_TOGGLE)});
    return toggle ? toggle.getAttribute("aria-pressed") : null;
  })()`);
}

async function clickExtensionsToggle(ctx) {
  const clicked = await ctx.eval(`(() => {
    const toggle = document.querySelector(${JSON.stringify(EXTENSIONS_TOGGLE)});
    if (!toggle) return false;
    toggle.click();
    return true;
  })()`);
  ctx.assert(clicked === true, "Extensions rail toggle was not found.");
}

async function closeExtensionsPanelIfOpen(ctx) {
  const pressed = await readExtensionsToggle(ctx);
  ctx.assert(pressed !== null, "Extensions rail toggle was not found.");
  if (pressed === "true") {
    await clickExtensionsToggle(ctx);
    await ctx.waitFor(
      `document.querySelector(${JSON.stringify(EXTENSIONS_TOGGLE)})?.getAttribute("aria-pressed") === "false"`,
      { label: "Extensions panel closed" },
    );
    await ctx.waitFor(
      `!document.body.innerText.includes(${JSON.stringify(EXTENSIONS_MARKER)})`,
      { label: "Extensions panel marker gone" },
    );
  }
}

async function dismissPromoDialogs(ctx) {
  for (let index = 0; index < 3; index += 1) {
    const foundDialog = await ctx.eval(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;
      const closeButton = Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent.trim() === "Close",
      );
      if (closeButton) {
        closeButton.click();
      } else {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
      return true;
    })()`);
    if (!foundDialog) return;
    await ctx.waitFor("!document.querySelector('[role=\"dialog\"]')", { label: "promo dialog dismissed" });
  }
}

async function readPersistedUiState(ctx) {
  return ctx.eval(`(() => {
    const raw = localStorage.getItem(${JSON.stringify(UI_STATE_KEY)}) ?? "{}";
    const parsed = JSON.parse(raw);
    return {
      raw,
      keys: Object.keys(parsed),
      hasSidePanelState: "sidePanelState" in parsed,
    };
  })()`);
}

export default {
  id: "side-panel-not-restored-on-load",
  kind: "user-facing",
  title: "Reloading the app shows only the chat — the side panel is never restored on launch",
  precondition: async (ctx) => {
    await waitForControl(ctx);
    const state = await ctx.waitFor(
      `(() => {
        const control = window.__openworkControl;
        const route = control.snapshot().route;
        if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
        const action = control.listActions().find((a) => a.id === "session.create_task");
        if (action && !action.disabled) return "ready";
        return null;
      })()`,
      { timeoutMs: 30_000, label: "session.create_task enabled (or welcome/signin)" },
    );
    return state === "blocked"
      ? "Profile is not onboarded (welcome/signin); side panel reload flow requires a workspace."
      : null;
  },
  steps: [
    {
      name: "Fresh task shows only the chat",
      run: async (ctx) => {
        await ctx.prove("A fresh task opens with the chat only and the Extensions side panel closed", {
          voiceover: vo[0],
          action: async () => {
            await waitForControl(ctx);
            await waitForRenderedBody(ctx);
            await ctx.control("session.create_task");
            const sessionId = await waitForActiveSessionId(ctx);
            ctx.log(`active session: ${sessionId}`);
            await closeExtensionsPanelIfOpen(ctx);
            await dismissPromoDialogs(ctx);
          },
          assert: async () => {
            const sessionId = await readRouteSessionId(ctx);
            ctx.assert(Boolean(sessionId), "No active session id after create_task.");
            const pressed = await readExtensionsToggle(ctx);
            ctx.assert(pressed === "false", `Expected Extensions toggle to be closed, got ${pressed}.`);
            const hasComposer = await ctx.eval("Boolean(document.querySelector('[contenteditable=\"true\"]'))");
            ctx.assert(hasComposer === true, "Composer was not present on the fresh task.");
            await ctx.expectNoText(EXTENSIONS_MARKER);
          },
          screenshot: {
            name: "chat-only",
            rejectText: [EXTENSIONS_MARKER],
          },
        });
      },
    },
    {
      name: "Extensions rail button opens the panel",
      run: async (ctx) => {
        await ctx.prove("Clicking the Extensions rail button opens the panel next to the chat", {
          voiceover: vo[1],
          action: async () => {
            await clickExtensionsToggle(ctx);
            await ctx.waitFor(
              `document.querySelector(${JSON.stringify(EXTENSIONS_TOGGLE)})?.getAttribute("aria-pressed") === "true"`,
              { label: "Extensions toggle pressed" },
            );
            await ctx.waitForText(EXTENSIONS_MARKER, { timeoutMs: 30_000 });
            await dismissPromoDialogs(ctx);
          },
          assert: async () => {
            await ctx.expectText(EXTENSIONS_MARKER);
            const pressed = await readExtensionsToggle(ctx);
            ctx.assert(pressed === "true", `Expected Extensions toggle to be open, got ${pressed}.`);
            const persisted = await readPersistedUiState(ctx);
            ctx.assert(
              persisted.hasSidePanelState === false,
              `Persisted UI state still included sidePanelState after toggling Extensions: ${persisted.raw}`,
            );
            ctx.log(`persisted ui-state keys after opening Extensions: ${JSON.stringify(persisted.keys)}`);
          },
          screenshot: {
            name: "extensions-open",
            requireText: ["Extensions (Legacy)"],
            rejectText: ["Use OpenWork Models without API keys"],
          },
        });
      },
    },
    {
      name: "Reload returns to the same task with chat only",
      run: async (ctx) => {
        let sessionId = null;

        await ctx.prove("Reloading the app returns to the same task without restoring the side panel", {
          voiceover: vo[2],
          action: async () => {
            sessionId = await readRouteSessionId(ctx);
            ctx.assert(Boolean(sessionId), "No active session id before reload.");
            ctx.log(`session before reload: ${sessionId}`);
            await ctx.eval("(() => { window.__sidePanelReloadSentinel = true; window.location.reload(); return true; })()");
            await ctx.waitFor("Boolean(window.__openworkControl) && !window.__sidePanelReloadSentinel", {
              timeoutMs: 60_000,
              label: "control API after reload",
            });
            await waitForRenderedBody(ctx);
            const routeHasSession = await ctx.eval(
              `window.__openworkControl.snapshot().route.includes(${JSON.stringify(sessionId)})`,
            );
            if (!routeHasSession) {
              await ctx.waitFor(
                `window.__openworkControl.listActions().some((a) => a.id === "session.open" && !a.disabled)`,
                { timeoutMs: 45_000, label: "session.open available after reload" },
              );
              await ctx.control("session.open", { sessionId });
            }
            await ctx.waitFor(
              `window.__openworkControl.snapshot().route.includes(${JSON.stringify(sessionId)})`,
              { timeoutMs: 30_000, label: "same session route after reload" },
            );
            await dismissPromoDialogs(ctx);
          },
          assert: async () => {
            const pressed = await readExtensionsToggle(ctx);
            ctx.assert(pressed === "false", `Expected Extensions toggle to be closed after reload, got ${pressed}.`);
            await ctx.expectNoText(EXTENSIONS_MARKER);
            const hasComposer = await ctx.eval("Boolean(document.querySelector('[contenteditable=\"true\"]'))");
            ctx.assert(hasComposer === true, "Composer was not present after reload.");
            const persisted = await readPersistedUiState(ctx);
            ctx.assert(
              persisted.hasSidePanelState === false,
              `Persisted UI state included sidePanelState after reload: ${persisted.raw}`,
            );
            ctx.log(`persisted ui-state raw after reload: ${persisted.raw}`);
            ctx.log(`persisted ui-state keys after reload: ${JSON.stringify(persisted.keys)}`);
          },
          screenshot: {
            name: "chat-after-reload",
            rejectText: [EXTENSIONS_MARKER],
          },
        });
      },
    },
  ],
};
