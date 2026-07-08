export default {
  id: "signin-browser-open-fallback",
  title: "Cloud sign-in surfaces browser open failure with copy-link fallback",
  requiredEnv: ["OPENWORK_SIMULATE_OPEN_EXTERNAL_FAILURE"],
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000 });
      },
    },
    {
      name: "Open Cloud Account signed-out state",
      run: async (ctx) => {
        await ctx.navigateHash("/settings/cloud-account");
        await ctx.expectHashIncludes("/settings/cloud-account");
        await ctx.waitFor(
          `(() => {
            const text = document.body.innerText;
            return text.includes("Sign in") || text.includes("Sign out");
          })()`,
          { timeoutMs: 30_000, label: "cloud account state" },
        );

        if (await ctx.hasText("Sign out")) {
          await ctx.clickText("Sign out");
          await ctx.expectText("Sign in", { timeoutMs: 15_000 });
        }
      },
    },
    {
      name: "Browser open failure shows fallback",
      run: async (ctx) => {
        await ctx.clickText("Sign in");
        await ctx.expectText("We couldn't open your browser automatically.", { timeoutMs: 10_000 });
        await ctx.expectText("Copy sign-in link");
        await ctx.expectText("Sign-in link or one-time code");
        await ctx.screenshot("browser-open-fallback", {
          claim: "When the system browser cannot be opened, Cloud sign-in shows a copy-link fallback and keeps paste-code auth reachable.",
          requireText: [
            "We couldn't open your browser automatically.",
            "Copy sign-in link",
            "Sign-in link or one-time code",
          ],
          rejectText: ["Finish signing in"],
          hashIncludes: "/settings/cloud-account",
        });
      },
    },
    {
      name: "Copy sign-in link works",
      run: async (ctx) => {
        await ctx.clickText("Copy sign-in link");
        let clipboardText = "";
        try {
          const value = await ctx.eval("navigator.clipboard.readText()");
          if (typeof value === "string") clipboardText = value;
        } catch (error) {
          ctx.log(`Clipboard read failed; falling back to copied label assertion: ${String(error)}`);
        }

        if (clipboardText) {
          ctx.assert(
            clipboardText.includes("desktopAuth=1"),
            "Copied sign-in link should include desktopAuth=1.",
          );
        } else {
          await ctx.expectText("Copied", { timeoutMs: 5_000 });
        }

        await ctx.screenshot("signin-link-copied", {
          claim: "The fallback copy action gives the user a usable OpenWork Cloud sign-in link.",
          requireText: [
            "We couldn't open your browser automatically.",
            "Sign-in link or one-time code",
          ],
          rejectText: ["Finish signing in"],
          hashIncludes: "/settings/cloud-account",
        });
      },
    },
  ],
};
