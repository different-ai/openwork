/**
 * Regression: many built-in browser tabs overflow horizontally, stay reachable,
 * and the selected/new tab is scrolled into view.
 */
import { mkdir } from "node:fs/promises";

const WORKSPACE_PATH = "/workspace/browser-tab-overflow-eval";
const TAB_COUNT = 14;

async function ensureWorkspaceAndSession(ctx) {
  await mkdir(WORKSPACE_PATH, { recursive: true });
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000 });

  const hasCreateTask = await ctx.eval(
    "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
  );
  if (!hasCreateTask) {
    const usedManualFolder = await ctx.eval(`(() => {
      const input = document.querySelector('input[placeholder="/workspace/my-project"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(WORKSPACE_PATH)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.trim() === 'Use this folder' && !candidate.disabled
      );
      if (!button) return false;
      button.click();
      return true;
    })()`);

    if (!usedManualFolder) {
      await ctx.eval(`(() => {
        const clickText = (text) => {
          const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
            (candidate.textContent ?? '').includes(text) && !candidate.disabled
          );
          if (button) button.click();
          return Boolean(button);
        };
        clickText('Get started');
        clickText('Local workspace');
        return true;
      })()`);

      await ctx.waitFor("document.body.innerText.includes('No folder')", {
        timeoutMs: 15_000,
        label: "workspace folder chooser",
      });
      await ctx.eval(`(() => {
        function findFiber(el) {
          const key = Object.keys(el).find((candidate) => candidate.startsWith('__reactFiber$'));
          return key ? el[key] : null;
        }
        const placeholder = Array.from(document.querySelectorAll('span,div,p')).find((node) =>
          (node.textContent ?? '').includes('No folder')
        );
        if (!placeholder) return { ok: false, error: 'No folder placeholder not found' };
        let fiber = findFiber(placeholder);
        while (fiber) {
          const name = (fiber.elementType && fiber.elementType.name) || (fiber.type && fiber.type.name) || '';
          if (name === 'CreateWorkspaceModal') break;
          fiber = fiber.return;
        }
        if (!fiber) return { ok: false, error: 'CreateWorkspaceModal fiber not found' };
        let hook = fiber.memoizedState;
        while (hook) {
          if (hook.queue && hook.queue.dispatch) {
            hook.queue.dispatch({ key: 'selectedFolder', value: ${JSON.stringify(WORKSPACE_PATH)} });
            hook.queue.dispatch({ key: 'pickingFolder', value: false });
            return { ok: true };
          }
          hook = hook.next;
        }
        return { ok: false, error: 'folder dispatch not found' };
      })()`);
      await ctx.waitFor(`(() => {
        const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
          candidate.textContent?.trim() === 'Create Workspace' && !candidate.disabled
        );
        if (!button) return false;
        button.click();
        return true;
      })()`, { timeoutMs: 15_000, label: "Create Workspace button" });
    }

    await ctx.waitFor("window.location.hash.includes('/workspace/ws_')", {
      timeoutMs: 60_000,
      label: "workspace route after onboarding",
    });
  }

  await ctx.waitFor(
    "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
    { timeoutMs: 60_000, label: "session.create_task action" },
  );

  const route = await ctx.eval("window.location.hash");
  if (!route.includes("/session/")) {
    await ctx.control("session.create_task");
    await ctx.waitFor("window.location.hash.includes('/session/')", {
      timeoutMs: 60_000,
      label: "session route",
    });
  }

  await ctx.eval(`(() => {
    for (const label of ['Continue without OpenWork Models', 'Close']) {
      const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.trim() === label && !candidate.disabled
      );
      if (button) button.click();
    }
    return true;
  })()`);
}

const tabMetricsExpression = `(async () => {
  const state = await window.__OPENWORK_ELECTRON__.browser.getState();
  const activeTabId = state?.activeTabId ?? null;
  const buttons = Array.from(document.querySelectorAll('button[aria-label^="Select tab:"]'));
  const scroller = buttons[0]
    ? Array.from(document.querySelectorAll('div')).find((node) =>
        node.contains(buttons[0]) && node.scrollWidth > node.clientWidth && getComputedStyle(node).overflowX !== 'visible'
      )
    : null;
  const activeButton = buttons.find((button) => button.closest('[id]')?.id === activeTabId) ?? null;
  const activeRect = activeButton?.getBoundingClientRect() ?? null;
  const scrollerRect = scroller?.getBoundingClientRect() ?? null;
  return {
    tabCount: buttons.length,
    activeTabId,
    labels: buttons.map((button) => button.getAttribute('aria-label')),
    hasScroller: Boolean(scroller),
    scrollLeft: scroller?.scrollLeft ?? 0,
    clientWidth: scroller?.clientWidth ?? 0,
    scrollWidth: scroller?.scrollWidth ?? 0,
    activeLabel: activeButton?.getAttribute('aria-label') ?? null,
    activeLeft: activeRect?.left ?? null,
    activeRight: activeRect?.right ?? null,
    scrollerLeft: scrollerRect?.left ?? null,
    scrollerRight: scrollerRect?.right ?? null,
    activeFullyVisible: Boolean(activeRect && scrollerRect &&
      activeRect.left >= scrollerRect.left - 1 && activeRect.right <= scrollerRect.right + 1),
  };
})()`;

export default {
  id: "builtin-browser-tab-overflow",
  title: "Built-in browser tab strip overflows and keeps active tab visible",
  spec: "evals/react-session-flows.md",
  steps: [
    {
      name: "Workspace and session are available",
      run: async (ctx) => {
        await ensureWorkspaceAndSession(ctx);
        const userAgent = await ctx.eval("navigator.userAgent");
        ctx.assert(userAgent.includes("Electron/"), `Expected Electron userAgent, got: ${userAgent}`);
      },
    },
    {
      name: "Open many built-in browser tabs",
      run: async (ctx) => {
        await ctx.eval("window.__OPENWORK_ELECTRON__.browser.closeAllTabs?.()", { awaitPromise: true });
        await ctx.control("browser.open_url", {
          provider: "builtin",
          url: "https://example.com/?openwork-overflow-tab=1",
        });
        await ctx.waitFor("document.querySelectorAll('button[aria-label^=\"Select tab:\"]').length >= 1", {
          timeoutMs: 20_000,
          label: "first browser tab visible",
        });

        const tabIds = [];
        for (let index = 2; index <= TAB_COUNT; index += 1) {
          const result = await ctx.eval(`window.__OPENWORK_ELECTRON__.browser.createTab(${JSON.stringify(
            `https://example.com/?openwork-overflow-tab=${index}`,
          )})`, { awaitPromise: true });
          tabIds.push(result.tabId);
        }
        ctx.log(`Created tabs: ${tabIds.join(", ")}`);
        await ctx.waitFor(`document.querySelectorAll('button[aria-label^="Select tab:"]').length >= ${TAB_COUNT}`, {
          timeoutMs: 30_000,
          label: `${TAB_COUNT} visible browser tabs`,
        });
        await ctx.screenshot("many-tabs-created");
      },
    },
    {
      name: "Tab strip overflows horizontally and active new tab is visible",
      run: async (ctx) => {
        const metrics = await ctx.eval(tabMetricsExpression, { awaitPromise: true });
        ctx.log(`Initial metrics: ${JSON.stringify(metrics)}`);
        ctx.assert(metrics.tabCount >= TAB_COUNT, `Expected at least ${TAB_COUNT} tab buttons, got ${metrics.tabCount}.`);
        ctx.assert(metrics.hasScroller, "Expected a horizontal scroll container for browser tabs.");
        ctx.assert(metrics.scrollWidth > metrics.clientWidth + 1, `Expected overflow: scrollWidth ${metrics.scrollWidth}, clientWidth ${metrics.clientWidth}.`);
        ctx.assert(metrics.activeFullyVisible, `Expected selected/new tab to be fully visible: ${JSON.stringify(metrics)}.`);
      },
    },
    {
      name: "A far tab remains accessible after selection",
      run: async (ctx) => {
        const firstTabId = await ctx.eval(`(() => {
          const button = document.querySelector('button[aria-label^="Select tab:"]');
          return button?.closest('[id]')?.id ?? null;
        })()`);
        ctx.assert(typeof firstTabId === "string" && firstTabId.length > 0, "Could not resolve first tab id.");
        await ctx.eval(`window.__OPENWORK_ELECTRON__.browser.selectTab(${JSON.stringify(firstTabId)})`, { awaitPromise: true });
        let metrics = null;
        const startedAt = Date.now();
        while (Date.now() - startedAt < 5_000) {
          metrics = await ctx.eval(tabMetricsExpression, { awaitPromise: true });
          if (metrics.activeFullyVisible) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        ctx.log(`After selecting first tab: ${JSON.stringify(metrics)}`);
        ctx.assert(metrics.activeFullyVisible, `Expected selected far tab to scroll into view: ${JSON.stringify(metrics)}.`);
        await ctx.screenshot("first-tab-selected-visible");
      },
    },
  ],
};
