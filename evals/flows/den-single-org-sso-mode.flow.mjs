export default {
  id: "den-single-org-sso-mode",
  title: "Den web renders SSO-only auth when singleton SSO is configured",
  spec: "docs/single-org-mode-plan.md",
  preserveTheme: true,
  steps: [
    {
      name: "Single-org SSO mode is SSO-only",
      run: async (ctx) => {
        await ctx.prove("Single-org SSO configured renders one SSO sign-in action", {
          action: async () => {
            await ctx.eval("(() => { window.location.href = 'http://127.0.0.1:3005/?mode=sign-up'; return true; })()");
            await ctx.waitFor("document.body.innerText.includes('Sign in to OpenWork.')", {
              timeoutMs: 30_000,
              label: "Den web rendered the single-org SSO-only auth panel",
            });
          },
          assert: async () => {
            const buttonLabels = await ctx.eval(
              "[...document.querySelectorAll('button')].map((button) => button.textContent.trim()).filter(Boolean)",
            );
            ctx.assert(buttonLabels.length === 1, `Expected exactly one button, got ${JSON.stringify(buttonLabels)}`);
            ctx.assert(buttonLabels[0] === "Continue with SSO", `Expected only SSO button, got ${JSON.stringify(buttonLabels)}`);
          },
          screenshot: {
            name: "single-org-sso-only-auth",
            requireText: ["Sign in to OpenWork.", "Continue with SSO"],
            rejectText: [
              "Create account",
              "Continue with GitHub",
              "Continue with Google",
              "Email address",
              "Password",
              "Forgot password?",
            ],
          },
        });

        await ctx.prove("Other auth entry points redirect to the root SSO-only page", {
          action: async () => {
            await ctx.eval("(() => { window.location.href = 'http://127.0.0.1:3005/workspace-claim?token=demo'; return true; })()");
            await ctx.waitFor("window.location.pathname === '/' && document.body.innerText.includes('Continue with SSO')", {
              timeoutMs: 30_000,
              label: "Workspace claim auth panel redirected to the root SSO-only auth panel",
            });
          },
          assert: async () => {
            const path = await ctx.eval("window.location.pathname");
            ctx.assert(path === "/", `Expected redirect to root, got ${path}`);
            const buttonLabels = await ctx.eval(
              "[...document.querySelectorAll('button')].map((button) => button.textContent.trim()).filter(Boolean)",
            );
            ctx.assert(buttonLabels.length === 1, `Expected exactly one button after redirect, got ${JSON.stringify(buttonLabels)}`);
            ctx.assert(buttonLabels[0] === "Continue with SSO", `Expected only SSO button after redirect, got ${JSON.stringify(buttonLabels)}`);
          },
        });
      },
    },
  ],
};
