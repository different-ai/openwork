/**
 * Codifies evals/cloud-auth-flows.md Flow 1 (happy path) via the paste-code
 * fallback: create a desktop handoff grant through the Den API, paste the
 * deep link into Settings -> Cloud -> Account, and assert the session lands.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL    Den API base, e.g. https://api.example.com
 * - OPENWORK_EVAL_DEN_TOKEN      Bearer session token for a Den account
 */
export default {
  id: "cloud-signin-handoff",
  title: "Cloud sign-in via desktop handoff paste code",
  spec: "evals/cloud-auth-flows.md#flow-1-cloud-sign-in-happy-path",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN"],
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000 });
      },
    },
    {
      name: "Create desktop handoff grant via Den API",
      run: async (ctx) => {
        const apiBase = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
        const response = await fetch(`${apiBase}/v1/auth/desktop-handoff`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ desktopScheme: "openwork" }),
        });
        const body = await response.text();
        ctx.assert(response.ok, `Handoff create failed: ${response.status} ${body.slice(0, 200)}`);
        const payload = JSON.parse(body);
        ctx.assert(typeof payload.openworkUrl === "string" && payload.openworkUrl.length > 0, "No openworkUrl in handoff response.");
        ctx.handoffUrl = payload.openworkUrl;
        ctx.log("Handoff grant created.");
      },
    },
    {
      name: "Open Settings -> Cloud -> Account",
      run: async (ctx) => {
        await ctx.navigateHash("/settings/cloud-account");
        await ctx.waitFor(
          `(() => {
            const text = document.body.innerText;
            return text.includes("Paste sign-in code") || text.includes("Sign out");
          })()`,
          { timeoutMs: 30_000, label: "cloud account state" },
        );
        ctx.alreadySignedIn = await ctx.hasText("Sign out");
        if (ctx.alreadySignedIn) ctx.log("Already signed in — skipping paste flow.");
      },
    },
    {
      name: "Paste deep link and finish sign-in",
      run: async (ctx) => {
        if (ctx.alreadySignedIn) return;
        await ctx.clickText("Paste sign-in code");
        await ctx.fill("#den-signin-link", ctx.handoffUrl);
        await ctx.clickText("Finish sign-in");
      },
    },
    {
      name: "Session is connected",
      run: async (ctx) => {
        await ctx.waitForText("Sign out", { timeoutMs: 45_000 });
        const token = await ctx.eval(
          "localStorage.getItem('openwork.den.authToken') ?? ''",
        );
        ctx.assert(typeof token === "string" && token.trim().length > 0, "No persisted den auth token.");
        await ctx.screenshot("signed-in");
      },
    },
  ],
};
