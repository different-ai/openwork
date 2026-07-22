export default {
  id: "signin-browser-open-fallback",
  title: "Cloud sign-in keeps the exact URL visible as a fallback",
  kind: "user-facing",
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
        // Navigate within the current workspace: the bare /settings/cloud-account
        // route redirect crashes the renderer on dev (pre-existing hooks-order
        // bug unrelated to this change).
        const route = await ctx.eval("window.__openworkControl.snapshot().route");
        const workspace = typeof route === "string" ? /^\/workspace\/[^/]+/.exec(route) : null;
        await ctx.navigateHash(`${workspace ? workspace[0] : ""}/settings/cloud-account`);
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
        await ctx.waitFor(
          "window.__openworkControl.execute('auth.status').then((result) => result.result?.status === 'signed_out').catch(() => false)",
          { timeoutMs: 15_000, label: "stable signed-out state" },
        );
      },
    },
    {
      name: "Sign in keeps the exact URL visible",
      run: async (ctx) => {
        await ctx.eval(`(() => {
          const button = [...document.querySelectorAll("button")].find(
            (entry) => entry.textContent?.trim() === "Sign in" && !entry.disabled,
          );
          button?.setAttribute("data-eval-cloud-signin", "true");
          return Boolean(button);
        })()`);
        await ctx.trustedClick('[data-eval-cloud-signin="true"]');
        await ctx.expectText("Copy the sign-in link and open it in any browser", { timeoutMs: 10_000 });
        await ctx.expectText("Copy sign-in link");
        await ctx.expectText("Sign-in link or one-time code");
        const signInUrl = await ctx.eval(`(() => {
          const link = [...document.querySelectorAll("a")].find((entry) =>
            entry.href.includes("desktopAuth=1") && entry.href.includes("mode=sign-in")
          );
          return link?.href ?? "";
        })()`);
        ctx.assert(
          typeof signInUrl === "string" && signInUrl.includes("desktopScheme=openwork"),
          "The complete desktop sign-in URL should be visible as a clickable link.",
        );
        await ctx.screenshot("browser-open-fallback", {
          claim: "After Sign in is clicked, the exact Cloud URL stays visible and clickable even when the automatic browser launch fails.",
          voiceover:
            "I click Sign in, and OpenWork keeps the exact Cloud URL directly below the button. Even when this machine cannot launch a browser, I can open or copy the link and finish signing in.",
          requireText: [
            "Copy the sign-in link and open it in any browser",
            "desktopAuth=1",
            "Copy sign-in link",
            "Sign-in link or one-time code",
          ],
          rejectText: ["We couldn't open your browser automatically."],
          hashIncludes: "/settings/cloud-account",
        });
      },
    },
    {
      name: "Copy sign-in link works",
      run: async (ctx) => {
        // Clipboard access is focus-gated; a real user's click always focuses
        // the window first, so restore that condition for the automated click.
        await ctx.client.send("Page.bringToFront");
        await ctx.clickText("Copy sign-in link");
        let clipboardText = "";
        try {
          const value = await ctx.eval("navigator.clipboard.readText()", { awaitPromise: true });
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
          voiceover:
            "One click copies the real sign-in link, so I can open it in any browser I like, sign in there, and paste the code back here to finish.",
          requireText: [
            "Copy the sign-in link and open it in any browser",
            "desktopAuth=1",
            "Copied",
            "Sign-in link or one-time code",
          ],
          rejectText: ["We couldn't open your browser automatically."],
          hashIncludes: "/settings/cloud-account",
        });
      },
    },
  ],
};
