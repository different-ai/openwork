import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "den-api-runtime-version";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const DEMO_EMAIL = "alex@acme.test";
const DEMO_PASSWORD = "OpenWorkDemo123!";

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: JSON.stringify(actual),
  });
  ctx.assert(condition, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

export default {
  id: FLOW_ID,
  title: "Org settings shows the running Den version inline",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_API_VERSION"],
  steps: [
    {
      name: "Org settings shows the running Den version beside its description",
      run: async (ctx) => {
        const apiBaseUrl = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
        const webBaseUrl = ctx.env.OPENWORK_EVAL_DEN_WEB_URL.trim().replace(/\/+$/, "");
        const expectedVersion = ctx.env.OPENWORK_EVAL_DEN_API_VERSION.trim();

        await ctx.prove("An operator can see the running Den version beside the Org settings description", {
          voiceover: vo[0],
          action: async () => {
            await ctx.client.send("Emulation.setDeviceMetricsOverride", {
              width: 1280,
              height: 800,
              deviceScaleFactor: 1,
              mobile: false,
            });
            await ctx.client.send("Page.navigate", { url: webBaseUrl });
            await ctx.waitFor("document.readyState === 'complete'", {
              timeoutMs: 30_000,
              label: "Den Web landing page",
            });

            await ctx.waitFor("location.pathname.startsWith('/dashboard') || Boolean(document.querySelector('input[type=\"email\"]'))", {
              timeoutMs: 30_000,
              label: "Den Web dashboard or email sign-in",
            });
            const needsSignIn = await ctx.eval("Boolean(document.querySelector('input[type=\"email\"]'))");
            if (needsSignIn) {
              await ctx.fill('input[type="email"]', DEMO_EMAIL);
              await ctx.clickText("Next", { selector: "button" });
              await ctx.waitFor("Boolean(document.querySelector('input[type=\"password\"]'))", {
                timeoutMs: 30_000,
                label: "Den Web password sign-in",
              });
              await ctx.fill('input[type="password"]', DEMO_PASSWORD);
              await ctx.clickText("Sign in", { selector: "button" });
            }
            await ctx.waitFor("location.pathname.startsWith('/dashboard')", {
              timeoutMs: 45_000,
              label: "signed-in Den dashboard",
            });
            await ctx.client.send("Page.navigate", { url: `${webBaseUrl}/dashboard/org-settings` });
            await ctx.waitFor("location.pathname === '/dashboard/org-settings'", {
              timeoutMs: 30_000,
              label: "Org settings page",
            });
            await ctx.waitFor(`Boolean(document.querySelector('[data-den-runtime-version=${JSON.stringify(expectedVersion)}]'))`, {
              timeoutMs: 20_000,
              label: "Den runtime version beside the Org settings description",
            });
          },
          assert: async () => {
            const healthResponse = await fetch(`${apiBaseUrl}/health`);
            const healthPayload = await healthResponse.json();
            witness(ctx, healthResponse.ok && healthPayload.version === expectedVersion, "The visible value matches the live Den API health version", healthPayload);

            const label = await ctx.eval(`(() => {
              const element = document.querySelector('[data-den-runtime-version]');
              if (!element) return null;
              const style = getComputedStyle(element);
              const bounds = element.getBoundingClientRect();
              const description = element.previousElementSibling;
              const descriptionBounds = description?.getBoundingClientRect();
              return {
                text: element.textContent?.trim() ?? '',
                version: element.getAttribute('data-den-runtime-version'),
                color: style.color,
                parentDisplay: getComputedStyle(element.parentElement).display,
                left: Math.round(bounds.left),
                top: Math.round(bounds.top),
                descriptionText: description?.textContent?.trim() ?? '',
                descriptionRight: descriptionBounds ? Math.round(descriptionBounds.right) : null,
                descriptionTop: descriptionBounds ? Math.round(descriptionBounds.top) : null,
              };
            })()`);
            witness(ctx, label?.text === `Den ${expectedVersion}` && label?.version === expectedVersion, "The inline label reports the running Den version", label);
            witness(ctx, label?.descriptionText === "Control your organization's settings." && label?.parentDisplay === "inline-flex" && label?.left > label?.descriptionRight && Math.abs(label?.top - label?.descriptionTop) <= 2, "The version sits directly to the right of the Org settings description", label);
            witness(ctx, label?.color === "rgb(156, 163, 175)", "The version uses the light-gray metadata color", label);
          },
          screenshot: {
            name: "den-web-org-settings-runtime-version",
            requireText: ["Org settings", "Control your organization's settings.", `Den ${expectedVersion}`],
          },
        });
      },
    },
  ],
};
