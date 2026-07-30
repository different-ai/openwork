import { ensureSessionWorkspace } from "./lib/session-workspace.mjs";

const READ_CHOOSER = `(() => {
  const heading = [...document.querySelectorAll('h1, h2, h3')]
    .find((entry) => /choose a destination/i.test(entry.textContent || ''));
  const panel = heading?.parentElement;
  if (!(panel instanceof HTMLElement)) return null;
  let panelFrame = panel;
  for (let candidate = panel; candidate instanceof HTMLElement; candidate = candidate.parentElement) {
    if (candidate.querySelector('button[aria-label="Close side panel"]')) {
      panelFrame = candidate;
      break;
    }
  }
  const actions = [...panel.querySelectorAll('button, a')]
    .filter((entry) => !entry.hasAttribute('disabled'))
    .map((entry) => ({
      label: (entry.getAttribute('aria-label') || entry.textContent || '').trim(),
      shortcut: entry.getAttribute('aria-keyshortcuts'),
    }))
    .filter((entry) => entry.label.length > 0);
  return {
    text: (panel.textContent || '').trim(),
    actions,
    width: Math.round(panelFrame.getBoundingClientRect().width),
  };
})()`;

export default {
  id: "right-panel-action-empty-state",
  title: "The built-in browser opens before a chat session starts",
  kind: "user-facing",
  steps: [
    {
      name: "Opening Browser from a session-free panel creates a usable tab",
      run: async (ctx) => {
        await ensureSessionWorkspace(
          ctx,
          "right-panel-action-empty-state",
        );
        const workspaceId = await ctx.eval(
          "(location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? localStorage.getItem('openwork.react.activeWorkspace') ?? ''",
        );
        ctx.assert(workspaceId, "Expected an active workspace before opening the session-free browser.");
        await ctx.navigateHash(`/workspace/${workspaceId}/session`);
        await ctx.waitFor(
          "!window.__openwork?.slice?.('route')?.selectedSessionId",
          { timeoutMs: 20_000, label: "workspace route without a selected session" },
        );
        await ctx.eval("window.__OPENWORK_ELECTRON__.browser.closeAllTabs?.()", { awaitPromise: true });
        await ctx.eval(`(() => {
          const button = document.querySelector('button[aria-label="Close side panel"]');
          if (button instanceof HTMLElement) button.click();
        })()`);
        await ctx.waitFor(
          "Boolean(document.querySelector('button[aria-label=\"Open side panel\"]'))",
          { timeoutMs: 5_000, label: "closed session-free side panel" },
        );
        const opened = await ctx.eval(`(() => {
          const button = document.querySelector('button[aria-label="Open side panel"]');
          if (!(button instanceof HTMLElement)) return false;
          button.click();
          return true;
        })()`);
        ctx.assert(opened === true, "The general Open side panel control was not actionable.");
        await ctx.waitFor(`Boolean(${READ_CHOOSER})`, {
          timeoutMs: 20_000,
          label: "right-panel action chooser",
        });
        const chooserBefore = await ctx.eval(READ_CHOOSER);

        await ctx.prove("Browser remains available before any chat session is selected or started", {
          action: async () => {
            const browserOpened = await ctx.eval(`(() => {
              const button = [...document.querySelectorAll('button')]
                .find((entry) => (entry.textContent || '').trim().startsWith('Browser'));
              if (!(button instanceof HTMLElement)) return false;
              button.click();
              return true;
            })()`);
            ctx.assert(browserOpened === true, "The Browser destination was not actionable.");
            await ctx.waitFor(
              "document.querySelectorAll('button[aria-label^=\"Select tab:\"]').length >= 1",
              { timeoutMs: 20_000, label: "browser tab created without a session" },
            );
          },
          assert: async () => {
            ctx.assert(chooserBefore, "The deliberate right-panel empty state was not found.");
            const labels = chooserBefore.actions.map((entry) => entry.label);
            ctx.assert(labels.length >= 2, `Expected at least two real destinations, got ${JSON.stringify(labels)}.`);
            ctx.assert(
              labels.some((label) => /browser/i.test(label)),
              `Expected a Browser destination in the desktop runtime, got ${JSON.stringify(labels)}.`,
            );
            ctx.assert(
              labels.some((label) => /files|artifacts/i.test(label)),
              `Expected a Files or Artifacts destination, got ${JSON.stringify(labels)}.`,
            );
            ctx.assert(chooserBefore.width >= 300, `Expected a usable panel width, got ${chooserBefore.width}px.`);
            const selectedSessionId = await ctx.eval(
              "window.__openwork?.slice?.('route')?.selectedSessionId ?? null",
            );
            ctx.assert(selectedSessionId === null, `Expected no selected session, got ${selectedSessionId}.`);
            const browserState = await ctx.eval(
              "window.__OPENWORK_ELECTRON__.browser.getState()",
              { awaitPromise: true },
            );
            ctx.assert(browserState?.tabs?.length >= 1, "Expected a native browser tab after activating Browser.");
          },
          screenshot: {
            name: "browser-open-without-session",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
