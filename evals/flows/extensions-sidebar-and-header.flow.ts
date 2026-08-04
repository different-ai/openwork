import { defineFlow } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "extensions-sidebar-and-header";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

const EXTENSIONS_SIDEBAR_DESTINATION = `(() => {
  const sidebar = document.querySelector('[data-sidebar="sidebar"]');
  if (!sidebar) return null;
  const destination = [...sidebar.querySelectorAll("a,button")]
    .find((entry) => (entry.textContent || "").trim() === "Extensions" || entry.getAttribute("aria-label") === "Extensions");
  if (!destination) return null;
  return {
    tag: destination.tagName,
    href: destination.getAttribute("href"),
    active: destination.getAttribute("aria-current") === "page" || destination.getAttribute("data-active") === "true",
    focused: document.activeElement === destination,
  };
})()`;

function appPrefix(route: string): string {
  const workspace = route.match(/^(\/workspace\/[^/]+)\/(?:session(?:\/.*)?|extensions(?:\/.*)?|settings(?:\/.*)?)$/);
  return workspace ? workspace[1] : "";
}

export default defineFlow({
  id: FLOW_ID,
  title: "Extensions are directly discoverable in the desktop sidebar with one correct page header",
  kind: "user-facing",
  steps: [
    {
      name: "Extensions sits directly below Search and before Pinned",
      run: async (ctx) => {
        await ctx.prove("The main sidebar places Extensions directly below Search and before Pinned", {
          voiceover: vo[0],
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
            const route = String(await ctx.eval("window.__openworkControl.snapshot().route || ''"));
            const prefix = appPrefix(route);
            const sessionRoute = `${prefix}/session`;

            await ctx.navigateHash(sessionRoute);
            await ctx.waitFor(`(() => {
              const sidebar = document.querySelector('[data-sidebar="sidebar"]');
              const search = sidebar?.querySelector('[aria-keyshortcuts]');
              const destination = [...(sidebar?.querySelectorAll("a,button") || [])]
                .find((entry) => (entry.textContent || "").trim() === "Extensions" || entry.getAttribute("aria-label") === "Extensions");
              if (!(search instanceof HTMLElement) || !(destination instanceof HTMLElement)) return false;
              const shell = sidebar.closest('[data-state]');
              if (shell?.getAttribute("data-state") === "collapsed") {
                const rail = sidebar.querySelector('[data-sidebar="rail"]');
                if (rail instanceof HTMLElement) rail.click();
                return false;
              }
              const destinationRect = destination.getBoundingClientRect();
              return destinationRect.width > 0
                && destinationRect.height > 0
                && !document.body.innerText.includes("Preparing workspace")
                && !document.body.innerText.includes("Failed to fetch");
            })()`, { timeoutMs: 30_000, label: "expanded primary sidebar" });
          },
          assert: async () => {
            const placement = await ctx.eval(`(() => {
              const sidebar = document.querySelector('[data-sidebar="sidebar"]');
              const search = sidebar?.querySelector('[aria-keyshortcuts]');
              const destination = [...(sidebar?.querySelectorAll("a,button") || [])]
                .find((entry) => (entry.textContent || "").trim() === "Extensions" || entry.getAttribute("aria-label") === "Extensions");
              if (!(search instanceof HTMLElement) || !(destination instanceof HTMLElement)) return null;
              const searchItem = search.closest('[data-sidebar="menu-item"]');
              const destinationItem = destination.closest('[data-sidebar="menu-item"]');
              const pinned = sidebar.querySelector('[data-global-pinned-sessions]');
              const footer = sidebar.querySelector('[data-sidebar="footer"]');
              return {
                adjacent: searchItem?.nextElementSibling === destinationItem,
                beforePinned: !pinned || Boolean(destination.compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING),
                inFooter: Boolean(footer?.contains(destination)),
              };
            })()`);
            ctx.assert(Boolean(placement), "Expected Search and Extensions in the main sidebar.");
            const measured = placement as { adjacent: boolean; beforePinned: boolean; inFooter: boolean };
            ctx.assert(measured.adjacent, "Expected Extensions immediately after Search.");
            ctx.assert(measured.beforePinned, "Expected Extensions before the Pinned section.");
            ctx.assert(!measured.inFooter, "Expected Extensions outside the account footer.");
          },
          screenshot: {
            name: "extensions-below-search",
            requireText: ["Search", "Extensions"],
            rejectText: ["Preparing workspace", "Failed to fetch", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Extensions opens as a main page and survives reload and history",
      run: async (ctx) => {
        await ctx.prove("Opening Extensions uses the main content area with one correct heading through reload and history", {
          voiceover: vo[1],
          action: async () => {
            const route = String(await ctx.eval("window.__openworkControl.snapshot().route || ''"));
            const prefix = appPrefix(route);
            const extensionsRoute = `${prefix}/extensions`;
            const sessionRoute = `${prefix}/session`;
            const clicked = await ctx.eval(`(() => {
              const sidebar = document.querySelector('[data-sidebar="sidebar"]');
              const destination = [...(sidebar?.querySelectorAll("a,button") || [])]
                .find((entry) => (entry.textContent || "").trim() === "Extensions" || entry.getAttribute("aria-label") === "Extensions");
              if (!(destination instanceof HTMLElement)) return false;
              destination.focus();
              destination.click();
              return true;
            })()`);
            ctx.assert(clicked === true, "Expected to focus and open Extensions from the sidebar.");
            await ctx.waitForRoute(extensionsRoute, { timeoutMs: 20_000 });

            await ctx.eval("location.reload()");
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after reload" });
            await ctx.waitForRoute(extensionsRoute, { timeoutMs: 20_000 });
            await ctx.waitFor(`(() => {
              const heading = [...document.querySelectorAll("h1")]
                .find((entry) => (entry.textContent || "").trim() === "Extensions");
              if (!(heading instanceof HTMLElement)) return false;
              const rect = heading.getBoundingClientRect();
              return rect.width > 0
                && rect.height > 0
                && !document.body.innerText.includes("Preparing workspace");
            })()`, { timeoutMs: 30_000, label: "visible Extensions page after reload" });
            const refreshed = await ctx.eval(`(() => {
              if (!document.body.innerText.includes("Failed to fetch")) return false;
              const refresh = [...document.querySelectorAll("button")]
                .find((entry) => (entry.textContent || "").trim() === "Refresh");
              if (!(refresh instanceof HTMLElement)) return false;
              refresh.click();
              return true;
            })()`);
            if (refreshed === true) {
              await ctx.waitFor(`!document.body.innerText.includes("Failed to fetch")`, {
                timeoutMs: 30_000,
                label: "Extensions refresh recovery",
              });
            }

            await ctx.navigateHash(sessionRoute);
            await ctx.waitForRoute(sessionRoute, { timeoutMs: 20_000 });
            await ctx.eval("history.back()");
            await ctx.waitForRoute(extensionsRoute, { timeoutMs: 20_000 });
          },
          assert: async () => {
            const route = String(await ctx.eval("window.__openworkControl.snapshot().route || ''"));
            ctx.assert(route.endsWith("/extensions"), `Expected main Extensions route, got ${route}.`);
            const headings = await ctx.eval(`([...document.querySelectorAll("h1")]
              .filter((entry) => (entry.textContent || "").trim() === "Extensions").length)`);
            ctx.assert(headings === 1, `Expected one Extensions page header, found ${JSON.stringify(headings)}.`);
            const destination = await ctx.eval(EXTENSIONS_SIDEBAR_DESTINATION);
            ctx.assert(Boolean(destination), "Extensions must remain represented in the main sidebar.");
            const measured = destination as { active: boolean };
            ctx.assert(measured.active, "Main Extensions destination must expose its active state.");
            const mainSurface = await ctx.eval("Boolean(document.querySelector('[data-extensions-main-surface]'))");
            ctx.assert(mainSurface === true, "Extensions must render in the main content surface.");
            const settingsHeading = await ctx.eval(`([...document.querySelectorAll("h1")]
              .some((entry) => (entry.textContent || "").trim() === "Settings"))`);
            ctx.assert(settingsHeading === false, "Extensions must not render inside the Settings page.");
          },
          screenshot: {
            name: "extensions-page-header",
            requireText: ["Extensions", "Everything your agent can use in one place.", "Refresh"],
            rejectText: ["Preparing workspace", "Failed to fetch", "Something went wrong"],
          },
        });
      },
    },
  ],
});
