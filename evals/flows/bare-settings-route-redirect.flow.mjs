/**
 * Regression guard: opening a bare /settings/* hash must not crash the renderer
 * when the route redirects into a workspace-scoped settings URL.
 */
export default {
  id: "bare-settings-route-redirect",
  title: "Bare settings route redirects without crashing",
  kind: "user-facing",
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000 });
      },
    },
    {
      name: "Open settings via a bare (workspace-less) URL",
      run: async (ctx) => {
        await ctx.navigateHash("/settings/cloud-account");
        await new Promise((resolve) => setTimeout(resolve, 500));
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 30_000,
          label: "control API after bare settings navigation",
        });
        await ctx.waitFor(
          `(() => {
            const text = document.body.innerText;
            return text.includes("Settings") && (text.includes("Account") || text.includes("OpenWork Cloud"));
          })()`,
          { timeoutMs: 30_000, label: "cloud account settings content" },
        );
        const bodyTextLength = await ctx.eval("document.body.innerText.length");
        ctx.assert(typeof bodyTextLength === "number" && bodyTextLength > 100, "Expected a non-blank settings page.");
        const hash = await ctx.eval("window.location.hash");
        ctx.assert(typeof hash === "string" && hash.includes("/settings/cloud-account"), "Expected hash to stay on cloud account settings.");
        await ctx.screenshot("bare-settings-cloud-account", {
          claim: "Opening settings from a bare workspace-less URL renders the Cloud Account page instead of crashing to a blank window.",
          voiceover: "We open Cloud Account settings directly, without choosing a workspace first. The settings page stays visible and ready to use instead of going blank.",
          requireText: ["Settings", "Account"],
          hashIncludes: "/settings/cloud-account",
        });
      },
    },
    {
      name: "Back to the app",
      run: async (ctx) => {
        await ctx.navigateHash("/");
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 30_000,
          label: "control API after returning home",
        });
        await ctx.waitFor("document.body.innerText.trim().length > 40", {
          timeoutMs: 30_000,
          label: "session UI content after redirect",
        });
        await ctx.screenshot("back-to-app", {
          claim: "The app stays fully alive after the redirect — back on the session view.",
          voiceover: "After visiting settings, we return to the main app. The session view is still alive and rendering normally.",
        });
      },
    },
  ],
};
