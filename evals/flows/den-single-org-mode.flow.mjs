export default {
  id: "den-single-org-mode",
  title: "Den web renders single-org auth mode",
  spec: "docs/single-org-mode-plan.md",
  preserveTheme: true,
  steps: [
    {
      name: "Single-org runtime config is exposed",
      run: async (ctx) => {
        await ctx.prove("Runtime config reports single-org mode", {
          action: async () => {
            await ctx.eval("(() => { window.location.href = 'http://127.0.0.1:3005'; return true; })()");
            await ctx.waitFor("document.body.innerText.includes('Create your account.')", {
              timeoutMs: 30_000,
              label: "Den web rendered the single-org auth panel",
            });
          },
          assert: async () => {
            const config = await ctx.eval(
              "fetch('/api/runtime-config').then((response) => response.json())",
              { awaitPromise: true },
            );
            ctx.assert(config?.orgMode === "single_org", `Expected single_org, got ${config?.orgMode}`);
            ctx.assert(config?.singleOrgSlug === "default", `Expected default singleton slug, got ${config?.singleOrgSlug}`);
            ctx.log(`runtime config: ${JSON.stringify(config)}`);
          },
          screenshot: {
            name: "single-org-auth",
            requireText: ["Create your account.", "Continue with SSO"],
            rejectText: ["Verify your email.", "Name your team."],
          },
        });
      },
    },
  ],
};
