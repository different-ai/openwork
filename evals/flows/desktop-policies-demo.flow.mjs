/**
 * Desktop Policies Demo — admin-to-member restriction flow.
 *
 * Story: Alex (admin/owner) configures desktop policies via the Den API.
 * After each change, the eval verifies the server returns the correct
 * effective config, then pushes it into the running desktop app via the
 * dev bridge to simulate the real-time refresh. Each state change is
 * captured as a validated frame.
 *
 * Acts:
 *   1. Baseline — clean state, light mode, all features allowed.
 *   2. Admin sets Genpact logo → logo appears in sidebar.
 *   3. Admin sets blue accent → app accent color changes.
 *   4. Admin restricts 4 policies → server confirms restrictions.
 *   5. Settings banner + notification center show policy notice.
 *   6. Admin partially restores → mixed state verified.
 *   7. Admin clears everything → app returns to default.
 */

const GENPACT_LOGO = "https://upload.wikimedia.org/wikipedia/commons/5/50/Genpact_Logo_Black_%283%29.png";

async function denFetch(ctx, path, options = {}) {
  const base = ctx.env.MICX_EVAL_DEN_API_URL;
  const token = ctx.env.MICX_EVAL_DEN_TOKEN;
  const url = `${base}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    throw new Error(`${options.method || "GET"} ${path} → ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return { status: res.status, body };
}

/** Fetch the effective desktop config from the server and push it into the app. */
async function syncConfigToApp(ctx) {
  const { body: config } = await denFetch(ctx, "/v1/me/desktop-config");
  await ctx.eval(`(() => {
    const bridge = window.__micxApplyDesktopConfig;
    if (typeof bridge === 'function') bridge(${JSON.stringify(config)});
    return true;
  })()`);
  return config;
}

export default {
  id: "desktop-policies-demo",
  title: "Admin configures desktop policies → member app reacts in real-time",
  spec: "evals/desktop-policy-white-label.md",
  requiredEnv: ["MICX_EVAL_DEN_API_URL", "MICX_EVAL_DEN_TOKEN"],
  steps: [
    // ---------------------------------------------------------------
    // ACT 1: Setup
    // ---------------------------------------------------------------
    {
      name: "Boot app in light mode, reset server state",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__micxControl)", {
          timeoutMs: 30_000,
          label: "window.__micxControl",
        });

        // Clean server: clear brand + restore all policies to defaults.
        await denFetch(ctx, "/v1/org", {
          method: "PATCH",
          body: JSON.stringify({ brandLogoUrl: null, brandAccentColor: null }),
        });
        const { body: policyList } = await denFetch(ctx, "/v1/desktop-policies");
        const defaultPol = policyList.desktopPolicies?.find((p) => p.isDefault);
        if (defaultPol) {
          await denFetch(ctx, `/v1/desktop-policies/${defaultPol.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              policyName: defaultPol.policyName,
              policy: {
                allowCustomProviders: true, allowZenModel: true,
                allowMultipleWorkspaces: true, allowControlSettings: true,
                allowManageExtensions: true, allowBuiltInExtensions: true,
                showWelcomePage: true,
              },
            }),
          });
        }
        ctx.log("Server state reset to defaults.");

        // Light mode + clear any leftover brand from the app.
        await ctx.eval(`(() => {
          localStorage.setItem('micx.react.settings.theme-mode', 'light');
          const bridge = window.__micxApplyDesktopConfig;
          if (typeof bridge === 'function') bridge({});
          return true;
        })()`);
        await ctx.eval("location.reload()");
        await ctx.waitFor("Boolean(window.__micxControl)", {
          timeoutMs: 30_000, label: "control API after reload",
        });
        await ctx.waitFor("document.documentElement.dataset.theme === 'light'", {
          timeoutMs: 5_000, label: "light mode",
        });
        await ctx.navigateHash("/session");
        await new Promise((r) => setTimeout(r, 800));
      },
    },

    {
      name: "Baseline: no brand, all policies allowed",
      run: async (ctx) => {
        await ctx.waitFor("document.body.innerText.trim().length > 40", { label: "body text" });

        const { body: config } = await denFetch(ctx, "/v1/me/desktop-config");
        ctx.assert(config.allowCustomProviders !== false, "providers allowed");
        ctx.assert(config.allowMultipleWorkspaces !== false, "workspaces allowed");
        ctx.assert(config.allowBuiltInExtensions !== false, "extensions allowed");
        ctx.assert(!config.brandLogoUrl, "no brand logo");
        ctx.assert(!config.brandAccentColor, "no brand accent");
        ctx.log("Server baseline confirmed: all allowed, no brand.");

        const logo = await ctx.eval("document.querySelector('[data-testid=\"brand-logo\"]')");
        ctx.assert(!logo, "No brand logo in sidebar.");

        await ctx.screenshot("01-baseline", {
          claim: "Baseline: light mode, all policies allowed, no brand logo.",
        });
      },
    },

    // ---------------------------------------------------------------
    // ACT 2: Admin sets brand logo
    // ---------------------------------------------------------------
    {
      name: "Admin sets Genpact logo → logo appears in sidebar",
      run: async (ctx) => {
        // Admin PATCH on the server.
        await denFetch(ctx, "/v1/org", {
          method: "PATCH",
          body: JSON.stringify({ brandLogoUrl: GENPACT_LOGO }),
        });

        // Verify server returns it.
        const config = await syncConfigToApp(ctx);
        ctx.assert(config.brandLogoUrl === GENPACT_LOGO, `Server returned brandLogoUrl=${config.brandLogoUrl}`);

        // Wait for logo in DOM.
        await ctx.waitFor(
          "Boolean(document.querySelector('[data-testid=\"brand-logo\"] img'))",
          { timeoutMs: 5_000, label: "brand logo in DOM" },
        );

        // Wait for image to load.
        await ctx.waitFor(`(() => {
          const img = document.querySelector('[data-testid="brand-logo"] img');
          return img && img.naturalWidth > 0 && img.complete;
        })()`, { timeoutMs: 8_000, label: "logo image loaded" });

        await ctx.screenshot("02-genpact-logo", {
          claim: "Admin set Genpact logo via PATCH /v1/org → logo rendered in member's sidebar.",
        });
      },
    },

    // ---------------------------------------------------------------
    // ACT 3: Admin sets accent color
    // ---------------------------------------------------------------
    {
      name: "Admin sets blue accent → app accent changes",
      run: async (ctx) => {
        await denFetch(ctx, "/v1/org", {
          method: "PATCH",
          body: JSON.stringify({ brandAccentColor: "blue" }),
        });

        const config = await syncConfigToApp(ctx);
        ctx.assert(config.brandAccentColor === "blue", `Server returned accent=${config.brandAccentColor}`);

        await ctx.waitFor("document.documentElement.dataset.brandAccent === 'blue'", {
          timeoutMs: 5_000, label: "blue accent applied",
        });

        const cssVar = await ctx.eval(
          "document.documentElement.style.getPropertyValue('--dls-accent').trim()",
        );
        ctx.assert(cssVar.includes("blue"), `CSS var should reference blue, got "${cssVar}"`);
        ctx.log(`accent CSS var: ${cssVar}`);

        await ctx.screenshot("03-blue-accent", {
          claim: "Admin set accent=blue → CSS variables updated. Logo still visible.",
        });
      },
    },

    // ---------------------------------------------------------------
    // ACT 4: Admin creates restrictive policy
    // ---------------------------------------------------------------
    {
      name: "Admin restricts providers, workspaces, extensions, zen model",
      run: async (ctx) => {
        const { body: policyList } = await denFetch(ctx, "/v1/desktop-policies");
        const defaultPol = policyList.desktopPolicies.find((p) => p.isDefault);

        await denFetch(ctx, `/v1/desktop-policies/${defaultPol.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            policyName: defaultPol.policyName,
            policy: {
              allowCustomProviders: false,
              allowZenModel: false,
              allowMultipleWorkspaces: false,
              allowBuiltInExtensions: false,
              allowControlSettings: true,
              allowManageExtensions: true,
              showWelcomePage: true,
            },
          }),
        });
        ctx.log("Admin restricted 4 policies on server.");

        const config = await syncConfigToApp(ctx);
        ctx.assert(config.allowCustomProviders === false, "providers blocked");
        ctx.assert(config.allowZenModel === false, "zen blocked");
        ctx.assert(config.allowMultipleWorkspaces === false, "workspaces blocked");
        ctx.assert(config.allowBuiltInExtensions === false, "extensions blocked");
        ctx.log("Server confirms 4 restrictions active.");

        await ctx.screenshot("04-restricted", {
          claim: "Admin restricted 4 policies → server confirms. Brand still active.",
        });
      },
    },

    // ---------------------------------------------------------------
    // ACT 5: Settings banner + notification
    // ---------------------------------------------------------------
    {
      name: "Settings shows policy banner, notification center has entry",
      run: async (ctx) => {
        await ctx.navigateHash("/settings/general");
        await ctx.waitForText("Settings", { timeoutMs: 10_000 });

        await ctx.waitFor(
          "Boolean(document.querySelector('[data-testid=\"desktop-policy-banner\"]'))",
          { timeoutMs: 5_000, label: "policy banner" },
        );

        await ctx.screenshot("05-settings-banner", {
          claim: "Settings page shows 'Organization policies active' banner.",
        });

        // Open notification center.
        await ctx.eval(`(() => {
          const bell = document.querySelector('[title="Notifications"]');
          if (bell) bell.click();
          return Boolean(bell);
        })()`);
        await new Promise((r) => setTimeout(r, 400));

        await ctx.screenshot("06-notification-center", {
          claim: "Notification bell shows desktop-policy-active entry.",
        });

        await ctx.eval("document.body.click()");
        await new Promise((r) => setTimeout(r, 200));
      },
    },

    // ---------------------------------------------------------------
    // ACT 6: Admin partially restores
    // ---------------------------------------------------------------
    {
      name: "Admin restores providers + workspaces, keeps extensions blocked",
      run: async (ctx) => {
        const { body: policyList } = await denFetch(ctx, "/v1/desktop-policies");
        const defaultPol = policyList.desktopPolicies.find((p) => p.isDefault);

        await denFetch(ctx, `/v1/desktop-policies/${defaultPol.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            policyName: defaultPol.policyName,
            policy: {
              allowCustomProviders: true,
              allowZenModel: true,
              allowMultipleWorkspaces: true,
              allowBuiltInExtensions: false,
              allowControlSettings: true,
              allowManageExtensions: true,
              showWelcomePage: true,
            },
          }),
        });

        const config = await syncConfigToApp(ctx);
        ctx.assert(config.allowCustomProviders === true, "providers restored");
        ctx.assert(config.allowMultipleWorkspaces === true, "workspaces restored");
        ctx.assert(config.allowBuiltInExtensions === false, "extensions still blocked");
        ctx.log(`mixed state: providers=${config.allowCustomProviders}, ext=${config.allowBuiltInExtensions}`);

        await ctx.navigateHash("/session");
        await new Promise((r) => setTimeout(r, 800));

        await ctx.screenshot("07-partial-restore", {
          claim: "Admin restored 3 of 4 policies → server confirms mixed state.",
        });
      },
    },

    // ---------------------------------------------------------------
    // ACT 7: Admin fully restores everything
    // ---------------------------------------------------------------
    {
      name: "Admin clears all restrictions + brand → app returns to default",
      run: async (ctx) => {
        const { body: policyList } = await denFetch(ctx, "/v1/desktop-policies");
        const defaultPol = policyList.desktopPolicies.find((p) => p.isDefault);

        // Restore all policies.
        await denFetch(ctx, `/v1/desktop-policies/${defaultPol.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            policyName: defaultPol.policyName,
            policy: {
              allowCustomProviders: true, allowZenModel: true,
              allowMultipleWorkspaces: true, allowBuiltInExtensions: true,
              allowControlSettings: true, allowManageExtensions: true,
              showWelcomePage: true,
            },
          }),
        });

        // Clear brand.
        await denFetch(ctx, "/v1/org", {
          method: "PATCH",
          body: JSON.stringify({ brandLogoUrl: null, brandAccentColor: null }),
        });

        const config = await syncConfigToApp(ctx);
        ctx.assert(config.allowCustomProviders !== false, "all policies restored");
        ctx.assert(config.allowBuiltInExtensions !== false, "extensions restored");
        ctx.assert(!config.brandLogoUrl, "brand logo cleared");
        ctx.assert(!config.brandAccentColor, "brand accent cleared");
        ctx.log("Server confirms: fully restored.");

        await ctx.waitFor("!document.documentElement.dataset.brandAccent", {
          timeoutMs: 5_000, label: "brand accent cleared",
        });
        const logoGone = await ctx.eval("!document.querySelector('[data-testid=\"brand-logo\"]')");
        ctx.assert(logoGone, "Logo removed from sidebar.");

        await ctx.screenshot("08-fully-restored", {
          claim: "Admin cleared all restrictions + brand → app returns to clean default state.",
        });
      },
    },
  ],
};
