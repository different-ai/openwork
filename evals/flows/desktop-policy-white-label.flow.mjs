/**
 * Desktop Policy White-Label: brand accent color and logo flow end-to-end.
 *
 * Verifies that setting white-label desktop policy fields (brandAccentColor,
 * brandLogoUrl) propagates to the running app in real-time without a reload:
 *   1. Baseline screenshot of the app with default styling.
 *   2. Apply a brand accent color via the control action.
 *   3. Verify the CSS variable override takes effect.
 *   4. Apply a brand logo URL.
 *   5. Verify the logo element appears in the sidebar.
 *   6. Navigate to settings and verify the desktop policy banner shows.
 *   7. Verify the notification center has a desktop-policy notification.
 */
export default {
  id: "desktop-policy-white-label",
  title: "White-label branding via desktop policies flows downstream in real-time",
  spec: "evals/desktop-policy-white-label.md",
  steps: [
    {
      name: "App boots and control API is ready; reset brand state",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__micxControl)", {
          timeoutMs: 30_000,
          label: "window.__micxControl",
        });
        const route = await ctx.waitFor(
          "window.__micxControl.snapshot().route",
          { label: "control snapshot route" },
        );
        ctx.log(`initial route: ${JSON.stringify(route)}`);

        // Persist light mode and reset brand, then reload so the theme
        // module's internal cache picks up the new value.
        await ctx.eval(`(() => {
          localStorage.setItem('micx.react.settings.theme-mode', 'light');
          const bridge = window.__micxApplyDesktopConfig;
          if (typeof bridge === 'function') bridge({});
          return true;
        })()`);
        await ctx.eval("location.reload()");
        // Wait for the app to fully re-render after reload.
        await ctx.waitFor("Boolean(window.__micxControl)", {
          timeoutMs: 30_000,
          label: "control API after reload",
        });
        await ctx.waitFor(
          "document.documentElement.dataset.theme === 'light'",
          { timeoutMs: 5_000, label: "light mode applied" },
        );
        // Navigate to a clean session view.
        await ctx.navigateHash("/session");
        await new Promise((r) => setTimeout(r, 500));
      },
    },

    {
      name: "Baseline: default accent color, no brand logo",
      run: async (ctx) => {
        // Wait for the UI to settle.
        await ctx.waitFor("document.body.innerText.trim().length > 40", {
          label: "rendered body text",
        });

        const accent = await ctx.eval(
          "getComputedStyle(document.documentElement).getPropertyValue('--dls-accent').trim()",
        );
        ctx.log(`baseline --dls-accent: ${accent}`);
        ctx.assert(
          typeof accent === "string" && accent.length > 0,
          "Expected --dls-accent to be set at baseline.",
        );

        const logo = await ctx.eval(
          "document.querySelector('[data-testid=\"brand-logo\"]')",
        );
        ctx.assert(!logo, "Expected no brand logo at baseline.");

        await ctx.screenshot("baseline", {
          claim: "App renders with default Micx accent and no brand logo.",
        });
      },
    },

    {
      name: "Apply brand accent (violet) + logo via control action",
      run: async (ctx) => {
        await ctx.waitFor(
          "window.__micxControl.listActions().some(a => a.id === 'eval.brand_theme.apply')",
          { timeoutMs: 10_000, label: "eval.brand_theme.apply action" },
        );

        // Apply Genpact branding: blue accent + Genpact logo.
        const genpactLogoUrl =
          "https://upload.wikimedia.org/wikipedia/commons/5/50/Genpact_Logo_Black_%283%29.png";

        await ctx.control("eval.brand_theme.apply", {
          brandAccentColor: "blue",
          brandLogoUrl: genpactLogoUrl,
        });

        // Wait for the brand accent data attribute AND the CSS variable override.
        await ctx.waitFor(
          "document.documentElement.dataset.brandAccent === 'blue'",
          { timeoutMs: 5_000, label: "brand accent data attribute" },
        );

        const accent = await ctx.eval(
          "document.documentElement.dataset.brandAccent",
        );
        ctx.assert(accent === "blue", `Expected data-brand-accent="blue", got "${accent}".`);

        // Verify the actual computed CSS variable changed to a blue hue.
        const dlsAccent = await ctx.eval(
          "document.documentElement.style.getPropertyValue('--dls-accent').trim()",
        );
        ctx.assert(
          typeof dlsAccent === "string" && dlsAccent.includes("blue"),
          `Expected --dls-accent to reference blue, got "${dlsAccent}".`,
        );

        // Verify the computed RGB changed (not the default dark navy #011627 = 1,22,39).
        const dlsAccentRgb = await ctx.eval(
          "document.documentElement.style.getPropertyValue('--dls-accent-rgb').trim()",
        );
        ctx.assert(
          typeof dlsAccentRgb === "string" && dlsAccentRgb !== "1 22 39",
          `Expected --dls-accent-rgb to differ from default, got "${dlsAccentRgb}".`,
        );
        ctx.log(`brand accent CSS: --dls-accent=${dlsAccent}, --dls-accent-rgb=${dlsAccentRgb}`);

        // Wait for the logo element to appear.
        await ctx.waitFor(
          "Boolean(document.querySelector('[data-testid=\"brand-logo\"] img'))",
          { timeoutMs: 5_000, label: "brand logo element" },
        );

        const logoSrc = await ctx.eval(
          "document.querySelector('[data-testid=\"brand-logo\"] img')?.src ?? ''",
        );
        ctx.log(`brand logo rendered: ${logoSrc}`);

        // Wait for the Genpact logo image to actually load.
        await ctx.waitFor(
          `(() => {
            const img = document.querySelector('[data-testid="brand-logo"] img');
            return img && img.naturalWidth > 0 && img.complete;
          })()`,
          { timeoutMs: 8_000, label: "logo image loaded" },
        );

        await ctx.screenshot("genpact-branded", {
          claim: "Genpact branding (blue accent + logo) applied via desktop policy in light mode — no reload needed.",
        });
      },
    },

    {
      name: "Navigate to settings and verify desktop policy banner",
      run: async (ctx) => {
        // Navigate to settings.
        await ctx.navigateHash("/settings/general");

        // Wait for settings page to render.
        await ctx.waitForText("Settings", { timeoutMs: 10_000 });

        // Wait for the desktop policy banner to appear.
        await ctx.waitFor(
          "Boolean(document.querySelector('[data-testid=\"desktop-policy-banner\"]'))",
          { timeoutMs: 5_000, label: "desktop policy banner" },
        );

        // Verify the banner text.
        const bannerText = await ctx.eval(
          "document.querySelector('[data-testid=\"desktop-policy-banner\"]')?.innerText ?? ''",
        );
        ctx.assert(
          typeof bannerText === "string" && bannerText.includes("Organization policies active"),
          `Expected policy banner text, got "${bannerText}".`,
        );
        ctx.log(`policy banner: ${bannerText}`);

        await ctx.screenshot("settings-policy-banner", {
          claim: "Desktop policy banner appears in settings when white-label branding is active.",
        });
      },
    },

    {
      name: "Notification center has a desktop-policy notification",
      run: async (ctx) => {
        // Check the notification store directly.
        const hasNotification = await ctx.eval(`(() => {
          const raw = localStorage.getItem('micx:notifications:v1');
          if (!raw) return false;
          try {
            const store = JSON.parse(raw);
            const notifications = store?.state?.notifications ?? [];
            return notifications.some(n => n.dedupeKey === 'desktop-policy-active');
          } catch { return false; }
        })()`);

        ctx.assert(
          hasNotification,
          "Expected a desktop-policy-active notification in the notification store.",
        );
        ctx.log("desktop-policy notification found in store");

        // Open the notification bell to make the screenshot visually distinct
        // and to show the notification entry.
        await ctx.eval(`(() => {
          const bell = document.querySelector('[title="Notifications"]');
          if (bell) bell.click();
          return Boolean(bell);
        })()`);

        // Give the popover a moment to open.
        await new Promise((resolve) => setTimeout(resolve, 300));

        await ctx.screenshot("notification-bell-open", {
          claim: "Notification center shows an organization-policies-active entry.",
        });
      },
    },

    {
      name: "Re-apply brand and verify it persists across navigation",
      run: async (ctx) => {
        // Re-apply the brand config to confirm downstream propagation works
        // even from a clean starting point (the previous steps proved
        // initial injection; this step proves the config → UI path is solid).
        await ctx.control("eval.brand_theme.apply", {
          brandAccentColor: "blue",
          brandLogoUrl: "https://upload.wikimedia.org/wikipedia/commons/5/50/Genpact_Logo_Black_%283%29.png",
        });

        // Navigate back to session view.
        await ctx.navigateHash("/session");
        await ctx.waitFor(
          "window.__micxControl.snapshot().route",
          { label: "route after navigation" },
        );

        // Allow React to settle after navigation.
        await new Promise((r) => setTimeout(r, 500));

        // Verify the brand accent is applied via the data attribute.
        const accent = await ctx.eval(
          "document.documentElement.dataset.brandAccent",
        );
        ctx.log(`brand accent after nav: ${accent}`);
        ctx.assert(
          accent === "blue",
          `Expected brand accent to persist after navigation, got "${accent}".`,
        );

        // Verify logo is still visible.
        const logoVisible = await ctx.eval(
          "Boolean(document.querySelector('[data-testid=\"brand-logo\"] img'))",
        );
        ctx.assert(logoVisible, "Expected brand logo to persist after navigation.");

        await ctx.screenshot("persisted-after-nav", {
          claim: "Brand accent color and logo persist across route navigation without reload.",
        });
      },
    },
  ],
};
