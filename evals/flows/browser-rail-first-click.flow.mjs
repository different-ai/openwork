import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/browser-rail-first-click.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("browser-rail-first-click");

const HERO_HEADING = "What do you need done?";

async function closeStaleDialogs(ctx) {
  await ctx.eval(`(() => {
    for (let index = 0; index < 3; index += 1) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    const active = document.activeElement;
    if (active && typeof active.blur === "function") active.blur();
    return true;
  })()`);
}

async function bootPrecondition(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
  await closeStaleDialogs(ctx);
  const state = await ctx.waitFor(
    `(() => {
      const route = String(window.__openworkControl.snapshot().route || "");
      if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
      if (!window.__OPENWORK_ELECTRON__?.browser?.createTab) return "no-browser";
      const action = window.__openworkControl.listActions().find((item) => item.id === "session.create_task");
      return action && !action.disabled ? "ready" : null;
    })()`,
    { timeoutMs: 30_000, label: "session.create_task enabled (or welcome/signin)" },
  );
  if (state === "blocked") return "Profile is not onboarded (welcome/signin); the browser rail needs a workspace.";
  if (state === "no-browser") return "The built-in browser bridge is unavailable; this flow needs the Electron shell.";
  return null;
}

/** State of the globe button in the right-hand rail. */
const READ_GLOBE = `(() => {
  const globe = Array.from(document.querySelectorAll("button"))
    .find((button) => (button.getAttribute("aria-label") || "").startsWith("Browser"));
  if (!globe) return { ok: false, reason: "browser rail button not found" };
  return {
    ok: true,
    label: globe.getAttribute("aria-label"),
    title: globe.getAttribute("title"),
    disabled: globe.disabled,
    pointerEvents: getComputedStyle(globe).pointerEvents,
    opacity: Number(getComputedStyle(globe).opacity),
  };
})()`;

/** Browser tab strip rendered by the side panel, plus the panel's own chrome. */
const READ_PANEL = `(() => {
  const labels = Array.from(document.querySelectorAll("button"))
    .map((button) => button.getAttribute("aria-label"))
    .filter(Boolean);
  return {
    hasNewTabButton: labels.includes("New tab"),
    selectTabLabels: labels.filter((label) => label.startsWith("Select tab:")),
  };
})()`;

/** The Electron browser bridge is promise-based, so these reads await it. */
function readBrowserTabs(ctx) {
  return ctx.eval(
    `(async () => ((await window.__OPENWORK_ELECTRON__.browser.getState())?.tabs || []).map((tab) => ({ id: tab.id, url: tab.url })))()`,
    { awaitPromise: true },
  );
}

async function waitForBrowserTabs(ctx, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let tabs = await readBrowserTabs(ctx);
  while (!predicate(tabs)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}; the browser reported ${JSON.stringify(tabs)}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    tabs = await readBrowserTabs(ctx);
  }
  return tabs;
}

async function readGlobe(ctx) {
  return ctx.waitFor(
    `(() => { const result = ${READ_GLOBE}; return result.ok ? result : null; })()`,
    { timeoutMs: 30_000, label: "browser rail button" },
  );
}

async function clickGlobe(ctx) {
  const clicked = await ctx.eval(`(() => {
    const globe = Array.from(document.querySelectorAll("button"))
      .find((button) => (button.getAttribute("aria-label") || "").startsWith("Browser"));
    if (!globe || globe.disabled) return false;
    globe.click();
    return true;
  })()`);
  ctx.assert(clicked, "The browser rail button was missing or disabled, so it could not be clicked.");
}

export default {
  id: "browser-rail-first-click",
  title: "The browser rail button opens the built-in browser on the first click",
  kind: "user-facing",
  precondition: bootPrecondition,
  steps: [
    {
      name: "Without a task the browser button explains itself",
      run: async (ctx) => {
        await ctx.prove("With no task open the globe is disabled and says why", {
          voiceover: vo[0],
          action: async () => {
            await closeStaleDialogs(ctx);
            await ctx.control("route.session");
            await ctx.waitForText(HERO_HEADING, { timeoutMs: 30_000 });
          },
          assert: async () => {
            const globe = await readGlobe(ctx);
            ctx.assert(globe.disabled, `Expected the globe to be disabled with no task open, got label "${globe.label}".`);
            ctx.assert(
              globe.label === "Browser opens once you start a task",
              `Expected the globe to explain itself, got "${globe.label}".`,
            );
            ctx.assert(globe.title === globe.label, "The globe tooltip should match its accessible name.");
            ctx.log(`no-task globe: ${JSON.stringify(globe)}`);
          },
          screenshot: {
            name: "no-task-browser-disabled",
            requireText: [HERO_HEADING],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Opening a task makes the browser button clickable with zero tabs",
      run: async (ctx) => {
        await ctx.prove("A task with no browser tabs still offers an enabled browser button", {
          voiceover: vo[1],
          action: async () => {
            await ctx.control("session.create_task");
            await ctx.waitFor(
              `String(window.__openworkControl.snapshot().route || "").includes("/session/ses_")`,
              { timeoutMs: 60_000, label: "session route after task creation" },
            );
            // Reach the state the bug was about: a task open and nothing browsed yet.
            await ctx.eval("window.__OPENWORK_ELECTRON__.browser.closeAllTabs()", { awaitPromise: true });
            await waitForBrowserTabs(ctx, (tabs) => tabs.length === 0, "the browser to have no tabs");
          },
          assert: async () => {
            const tabs = await readBrowserTabs(ctx);
            ctx.assert(tabs.length === 0, `Expected no browser tabs before the first click, got ${tabs.length}.`);
            const globe = await readGlobe(ctx);
            ctx.assert(!globe.disabled, "The globe is still disabled while a task is open with no browser tabs.");
            ctx.assert(globe.label === "Browser", `Expected the globe to read "Browser", got "${globe.label}".`);
            ctx.assert(globe.pointerEvents !== "none", "The globe still ignores pointer events.");
            ctx.assert(globe.opacity > 0.9, `The globe still renders dimmed at opacity ${globe.opacity}.`);
            ctx.log(`task globe with zero tabs: ${JSON.stringify(globe)}`);
          },
          screenshot: {
            name: "task-open-browser-enabled",
            hashIncludes: "/session/ses_",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "The first click opens the browser on a real page",
      run: async (ctx) => {
        await ctx.prove("Clicking the globe creates a browser tab and shows the panel", {
          voiceover: vo[2],
          action: async () => {
            await clickGlobe(ctx);
            // A new tab starts on about:blank and then navigates, so wait for the
            // real page rather than for the tab to merely exist.
            await waitForBrowserTabs(
              ctx,
              (tabs) => tabs.some((tab) => tab.url && tab.url !== "about:blank"),
              "the rail click to open a browser tab on a real page",
            );
          },
          assert: async () => {
            const tabs = await readBrowserTabs(ctx);
            ctx.assert(tabs.length === 1, `Expected exactly one browser tab after the first click, got ${tabs.length}.`);
            ctx.assert(
              Boolean(tabs[0].url) && tabs[0].url !== "about:blank",
              `The rail click opened an empty tab (${tabs[0].url}) instead of a usable page.`,
            );
            const panel = await ctx.waitFor(
              `(() => { const result = ${READ_PANEL}; return result.hasNewTabButton && result.selectTabLabels.length > 0 ? result : null; })()`,
              { timeoutMs: 30_000, label: "browser panel chrome" },
            );
            ctx.log(`opened ${tabs[0].url} with tabs ${JSON.stringify(panel.selectTabLabels)}`);
            ctx.output("browser-tabs-after-first-click", JSON.stringify({ tabs, panel }, null, 2));
          },
          screenshot: {
            name: "first-click-opens-browser",
            hashIncludes: "/session/ses_",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Clicking again closes the browser and keeps the tab",
      run: async (ctx) => {
        await ctx.prove("The globe still toggles the panel closed without discarding the tab", {
          voiceover: vo[3],
          action: async () => {
            await clickGlobe(ctx);
            await ctx.waitFor(
              `(() => { const result = ${READ_PANEL}; return result.hasNewTabButton ? null : true; })()`,
              { timeoutMs: 30_000, label: "browser panel closed" },
            );
          },
          assert: async () => {
            const tabs = await readBrowserTabs(ctx);
            ctx.assert(tabs.length === 1, `Closing the panel should keep the opened tab, but the browser has ${tabs.length}.`);
            const globe = await readGlobe(ctx);
            ctx.assert(!globe.disabled, "The globe became unclickable after closing the panel.");
            ctx.log(`after toggle close: tabs=${tabs.length} globe=${JSON.stringify(globe)}`);
          },
          screenshot: {
            name: "second-click-closes-browser",
            hashIncludes: "/session/ses_",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
