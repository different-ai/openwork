/**
 * internal flow demo (spec: evals/voiceovers/control-pane-extensions-action-removed.md):
 * the redundant `route.settings.extensions` control action is removed from the
 * Control UI pane; `settings.panel.open({panel:"extensions"})` still opens the
 * Extensions settings.
 */

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("control-pane-extensions-action-removed");

export default {
  id: "control-pane-extensions-action-removed",
  title: "Control pane: redundant extensions action removed, generic panel open still works",
  kind: "internal",
  steps: [
    {
      name: "App booted with the control surface ready",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000, label: "window.__openworkControl" });
        await ctx.waitFor("document.body.innerText.trim().length > 40", { label: "rendered body text" });
      },
    },
    {
      name: "Control pane no longer lists route.settings.extensions",
      run: async (ctx) => {
        await ctx.prove("The control pane omits the redundant extensions action", {
          claim: "The Control UI action list no longer contains route.settings.extensions, while settings.panel.open and the other route shortcuts remain.",
          voiceover: vo[0],
          assert: async () => {
            const ids = await ctx.eval("window.__openworkControl.listActions().map((a) => a.id)");
            ctx.assert(Array.isArray(ids) && ids.length > 0, "Control pane returned no actions.");
            ctx.assert(!ids.includes("route.settings.extensions"), "route.settings.extensions is still registered in the control pane.");
            ctx.assert(ids.includes("settings.panel.open"), "settings.panel.open is missing from the control pane.");
            ctx.assert(ids.includes("route.settings.general"), "route.settings.general is missing — over-deleted.");
            ctx.assert(ids.includes("route.settings.skills"), "route.settings.skills is missing — over-deleted.");
            ctx.output("control-pane-action-ids.json", JSON.stringify(ids, null, 2));
          },
          screenshot: { name: "control-pane-intact", rejectText: ["Open MCP and extension settings"] },
        });
      },
    },
    {
      name: "settings.panel.open still opens the Extensions panel",
      run: async (ctx) => {
        await ctx.prove("The generic panel action still lands on Extensions", {
          claim: "Executing settings.panel.open with {panel:\"extensions\"} navigates to #/settings/extensions and renders the Extensions settings screen.",
          voiceover: vo[1],
          action: async () => {
            // Start from a different settings tab so the navigation is observable.
            await ctx.navigateHash("/settings/general");
            await ctx.waitFor("location.hash.includes('/settings/general')", { label: "on settings general" });
            const result = await ctx.control("settings.panel.open", { panel: "extensions" });
            ctx.assert(result?.panel === "extensions", `Unexpected control result: ${JSON.stringify(result)}`);
            await ctx.waitFor("location.hash.includes('/settings/extensions')", { timeoutMs: 30_000, label: "navigated to /settings/extensions" });
          },
          assert: async () => {
            await ctx.expectHashIncludes("/settings/extensions");
            await ctx.expectText("Extensions");
          },
          screenshot: { name: "extensions-panel-open", requireText: ["Extensions"], hashIncludes: "/settings/extensions" },
        });
      },
    },
  ],
};
