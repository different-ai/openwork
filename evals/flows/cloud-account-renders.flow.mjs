/**
 * The Cloud Account settings surface renders a coherent state: either the
 * signed-out panel (sign in, create account, paste sign-in code) or the
 * signed-in account section. Catches blank/crashed cloud surfaces.
 */
export default {
  id: "cloud-account-renders",
  title: "Cloud Account settings renders signed-in or signed-out state",
  spec: "evals/cloud-auth-flows.md",
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000 });
      },
    },
    {
      name: "Navigate to Settings -> Cloud -> Account",
      run: async (ctx) => {
        await ctx.navigateHash("/settings/cloud-account");
        await ctx.waitFor(
          "window.location.hash.includes('/settings/cloud-account')",
          { label: "cloud account route" },
        );
      },
    },
    {
      name: "Signed-in or signed-out state renders",
      run: async (ctx) => {
        await ctx.waitFor(
          `(() => {
            const text = document.body.innerText;
            const signedOut = text.includes("Paste sign-in code");
            const signedIn = text.includes("Sign out");
            return signedOut || signedIn;
          })()`,
          { timeoutMs: 30_000, label: "cloud account state (signed in or out)" },
        );
        const signedIn = await ctx.hasText("Sign out");
        ctx.log(`cloud account state: ${signedIn ? "signed in" : "signed out"}`);
        await ctx.screenshot("cloud-account");
      },
    },
  ],
};
