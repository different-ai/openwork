import { defineFlow, type FlowContext } from "../runner/flow.ts";
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

function settingsPrefix(route: string): string {
  const workspace = route.match(/^(\/workspace\/[^/]+)\/(?:session|settings(?:\/.*)?)$/);
  return workspace ? workspace[1] : "";
}

export default defineFlow({
  id: FLOW_ID,
  title: "Extensions are directly discoverable in the desktop sidebar with one correct page header",
  kind: "user-facing",
  steps: [
    {
      name: "Sidebar navigation and Extensions header survive history and collapse",
      run: async (ctx) => {
        await ctx.prove("The desktop sidebar opens the existing Extensions route and keeps its active state and single header", {
          voiceover: vo[0],
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
            const route = String(await ctx.eval("window.__openworkControl.snapshot().route || ''"));
            const prefix = settingsPrefix(route);
            const sessionRoute = `${prefix}/session`;
            const extensionsRoute = `${prefix}/settings/extensions`;
            const generalRoute = `${prefix}/settings/general`;

            await ctx.navigateHash(sessionRoute);
            await ctx.waitFor(EXTENSIONS_SIDEBAR_DESTINATION, { timeoutMs: 20_000, label: "Extensions sidebar destination" });
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

            await ctx.navigateHash(generalRoute);
            await ctx.waitForRoute(generalRoute, { timeoutMs: 20_000 });
            await ctx.eval("history.back()");
            await ctx.waitForRoute(extensionsRoute, { timeoutMs: 20_000 });

            const toggled = await ctx.eval(`(() => {
              const trigger = document.querySelector('[data-sidebar="rail"], [data-sidebar="trigger"]');
              if (!(trigger instanceof HTMLElement)) return false;
              trigger.click();
              return true;
            })()`);
            ctx.assert(toggled === true, "Expected the desktop sidebar collapse control.");
            await new Promise((resolve) => setTimeout(resolve, 300));
          },
          assert: async () => {
            const route = String(await ctx.eval("window.__openworkControl.snapshot().route || ''"));
            ctx.assert(route.endsWith("/settings/extensions"), `Expected Extensions route, got ${route}.`);
            const headings = await ctx.eval(`([...document.querySelectorAll("h1")]
              .filter((entry) => (entry.textContent || "").trim() === "Extensions").length)`);
            ctx.assert(headings === 1, `Expected one Extensions page header, found ${JSON.stringify(headings)}.`);
            const destination = await ctx.eval(EXTENSIONS_SIDEBAR_DESTINATION);
            ctx.assert(Boolean(destination), "Extensions must remain represented in the collapsed sidebar.");
            const measured = destination as { active: boolean };
            ctx.assert(measured.active, "Extensions sidebar destination must expose its active state.");
          },
          screenshot: {
            name: "extensions-sidebar-collapsed",
            requireText: ["Extensions"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
});
