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
  title: "Den Web discreetly shows the running Den version",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_API_VERSION"],
  steps: [
    {
      name: "The dashboard sidebar shows the running Den version",
      run: async (ctx) => {
        const apiBaseUrl = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
        const webBaseUrl = ctx.env.OPENWORK_EVAL_DEN_WEB_URL.trim().replace(/\/+$/, "");
        const expectedVersion = ctx.env.OPENWORK_EVAL_DEN_API_VERSION.trim();

        await ctx.prove("An operator can discreetly see the running Den version in the dashboard sidebar", {
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
            await ctx.waitFor(`Boolean(document.querySelector('[data-den-runtime-version=${JSON.stringify(expectedVersion)}]'))`, {
              timeoutMs: 20_000,
              label: "Den runtime version in dashboard sidebar",
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
              return {
                text: element.textContent?.trim() ?? '',
                version: element.getAttribute('data-den-runtime-version'),
                fontSize: style.fontSize,
                left: Math.round(bounds.left),
                bottom: Math.round(bounds.bottom),
                viewportHeight: window.innerHeight,
              };
            })()`);
            witness(ctx, label?.text === `Den ${expectedVersion}` && label?.version === expectedVersion, "The sidebar label reports the running Den version", label);
            witness(ctx, label?.fontSize === "10px" && label?.left < 260 && label?.bottom <= label?.viewportHeight, "The version remains discreetly positioned at the bottom of the sidebar", label);
          },
          screenshot: {
            name: "den-web-runtime-version",
            requireText: ["Dashboard", `Den ${expectedVersion}`],
          },
        });
      },
    },
  ],
};
