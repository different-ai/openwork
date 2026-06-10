/**
 * Smoke: the app boots, the automation control API is live, and a known route
 * renders real content.
 */
export default {
  id: "app-smoke",
  title: "App boots and renders a known route",
  spec: "evals/react-session-flows.md",
  steps: [
    {
      name: "CDP target is the Electron app (or dev web build)",
      run: async (ctx) => {
        const userAgent = await ctx.eval("navigator.userAgent");
        ctx.assert(typeof userAgent === "string" && userAgent.length > 0, "No userAgent.");
        ctx.log(`userAgent: ${userAgent}`);
      },
    },
    {
      name: "Automation control API becomes available",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 30_000,
          label: "window.__openworkControl",
        });
      },
    },
    {
      name: "App reports a known route",
      run: async (ctx) => {
        const route = await ctx.waitFor(
          "window.__openworkControl.snapshot().route",
          { label: "control snapshot route" },
        );
        ctx.log(`route: ${JSON.stringify(route)}`);
      },
    },
    {
      name: "UI rendered meaningful content",
      run: async (ctx) => {
        await ctx.waitFor("document.body.innerText.trim().length > 40", {
          label: "rendered body text",
        });
        await ctx.screenshot("booted");
      },
    },
  ],
};
