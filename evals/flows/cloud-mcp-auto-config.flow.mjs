/**
 * After cloud sign-in, the Den cloud MCP ("OpenWork Cloud Control") is
 * auto-configured with a first-party org-scoped token: no browser OAuth,
 * entry appears under YOUR APPS, sync marker persisted.
 *
 * Requires the programmatic runner (evals/runner) and a reachable Den API:
 * - OPENWORK_EVAL_DEN_API_URL    Den API base, e.g. http://127.0.0.1:8790
 * - OPENWORK_EVAL_DEN_TOKEN      Bearer session token for a Den account
 *
 * The app under test must be bootstrapped against the same Den control
 * plane (desktop-bootstrap.json) and signed out at start, or already signed
 * in to the same account.
 */
export default {
  id: "cloud-mcp-auto-config",
  title: "Cloud MCP auto-configures with first-party token on sign-in",
  spec: "evals/cloud-auth-flows.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN"],
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000 });
      },
    },
    {
      name: "Sign in via desktop handoff (skipped when already signed in)",
      run: async (ctx) => {
        const signedIn = await ctx.eval(
          "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())",
        );
        if (signedIn) {
          ctx.log("Already signed in; reusing session.");
          return;
        }

        const apiBase = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
        const response = await fetch(`${apiBase}/v1/auth/desktop-handoff`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ desktopScheme: "openwork" }),
        });
        ctx.assert(response.ok, `Handoff create failed: ${response.status}`);
        const payload = await response.json();

        await ctx.navigateHash("/settings/cloud-account");
        await ctx.clickText("Paste sign-in code", { timeoutMs: 30_000 });
        await ctx.fill("#den-signin-link", payload.openworkUrl);
        await ctx.clickText("Finish sign-in");
        await ctx.waitFor(
          "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())",
          { timeoutMs: 30_000, label: "persisted den auth token" },
        );
      },
    },
    {
      name: "Active organization resolves",
      run: async (ctx) => {
        await ctx.waitFor(
          "Boolean((localStorage.getItem('openwork.den.activeOrgId') ?? '').trim())",
          { timeoutMs: 60_000, label: "active org" },
        );
      },
    },
    {
      name: "Cloud MCP auto-config marker is written",
      run: async (ctx) => {
        await ctx.waitFor(
          "Boolean(localStorage.getItem('openwork.den.mcp.sync'))",
          { timeoutMs: 120_000, label: "openwork.den.mcp.sync marker" },
        );
        ctx.log(`marker: ${await ctx.eval("localStorage.getItem('openwork.den.mcp.sync')")}`);
      },
    },
    {
      name: "OpenWork Cloud Control appears as a configured app",
      run: async (ctx) => {
        await ctx.navigateHash("/settings/extensions/mcp");
        await ctx.waitForText("OpenWork Cloud Control", { timeoutMs: 30_000 });
        await ctx.screenshot("cloud-mcp-configured");
      },
    },
  ],
};
