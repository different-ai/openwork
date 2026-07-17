import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denWebUrl, signInViaBrowser } from "./lib/den-web.mjs";

// Narration is loaded from the approved script
// (evals/voiceovers/openwork-models-hidden-single-org-dashboard.md).
// The runner fails this flow if the narration drifts from that script.
const FLOW_ID = "openwork-models-hidden-single-org-dashboard";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEMO_EMAIL = process.env.DEN_DEMO_OWNER_EMAIL ?? "alex@acme.test";
const DEMO_PASSWORD = process.env.DEN_DEMO_OWNER_PASSWORD ?? "OpenWorkDemo123!";

export default {
  id: FLOW_ID,
  title: "Single-org (self-hosted) dashboard hides the OpenWork Models nav and page",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Frame 1 — sign in to the self-hosted dashboard",
      run: async (ctx) => {
        await ctx.prove("The dashboard is a single-org (self-hosted) deployment and the admin can sign in", {
          voiceover: vo[0],
          action: async () => {
            await signInViaBrowser(ctx, DEMO_EMAIL, DEMO_PASSWORD);
          },
          assert: async () => {
            const config = await ctx.eval(
              "fetch('/api/runtime-config').then((response) => response.json())",
              { awaitPromise: true },
            );
            ctx.assert(config?.orgMode === "single_org", `Expected single_org runtime config, got ${config?.orgMode}`);
            ctx.log(`runtime config: ${JSON.stringify(config)}`);
            await ctx.expectText("Dashboard");
          },
          screenshot: {
            name: "single-org-dashboard-signed-in",
            requireText: ["Dashboard"],
          },
        });
      },
    },
    {
      name: "Frame 2 — Models nav goes straight to LLM Providers",
      run: async (ctx) => {
        await ctx.prove("The Models nav group contains no OpenWork Models entry and lands on LLM Providers", {
          voiceover: vo[1],
          action: async () => {
            await ctx.waitFor(`(() => {
              const nav = document.querySelector('nav');
              if (!nav) return false;
              const entry = [...nav.querySelectorAll('a, button')].find((el) => (el.textContent ?? '').trim().startsWith('Models'));
              if (!entry) return false;
              if (window.location.pathname.includes('custom-llm-providers')) return true;
              entry.click();
              return false;
            })()`, { timeoutMs: 30_000, label: "Models nav clicked -> LLM Providers route" });
            await ctx.waitForText("LLM Providers", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const nav = await ctx.eval(`(() => {
              const nav = document.querySelector('nav');
              const links = [...(nav?.querySelectorAll('a') ?? [])].map((a) => ({
                text: (a.textContent ?? '').trim(),
                href: a.getAttribute('href') ?? '',
              }));
              return {
                pathname: window.location.pathname,
                hasOpenWorkModels: links.some((l) => l.text.includes('OpenWork Models')) || (nav?.innerText ?? '').includes('OpenWork Models'),
                hasInferenceLink: links.some((l) => l.href.includes('/dashboard/inference')),
                hasLlmProvidersLink: links.some((l) => l.text.includes('LLM Providers')),
              };
            })()`);
            ctx.assert(nav.pathname.includes("custom-llm-providers"), `Models nav should land on LLM Providers, got ${nav.pathname}`);
            ctx.assert(nav.hasLlmProvidersLink, "The Models group should still offer LLM Providers.");
            ctx.assert(!nav.hasOpenWorkModels, "The navigation must not mention OpenWork Models on a self-hosted deployment.");
            ctx.assert(!nav.hasInferenceLink, "The navigation must not link to /dashboard/inference on a self-hosted deployment.");
          },
          screenshot: {
            name: "single-org-models-nav-llm-providers-only",
            requireText: ["LLM Providers"],
            rejectText: ["OpenWork Models"],
          },
        });
      },
    },
    {
      name: "Frame 3 — direct inference URL bounces to LLM Providers",
      run: async (ctx) => {
        await ctx.prove("Visiting /dashboard/inference directly redirects to LLM Providers", {
          voiceover: vo[2],
          action: async () => {
            await ctx.eval(`(() => { window.location.href = ${JSON.stringify(`${denWebUrl()}/dashboard/inference`)}; return true; })()`);
            await ctx.waitFor("window.location.pathname.includes('custom-llm-providers')", {
              timeoutMs: 30_000,
              label: "redirect to the LLM Providers route",
            });
            await ctx.waitForText("LLM Providers", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const pathname = await ctx.eval("window.location.pathname");
            ctx.assert(pathname.includes("custom-llm-providers"), `Expected the LLM Providers route, got ${pathname}`);
            await ctx.expectNoText("Subscribe with Stripe");
            await ctx.expectNoText("The best open-source models, ready for your whole team.");
          },
          screenshot: {
            name: "single-org-inference-redirected",
            requireText: ["LLM Providers"],
            rejectText: ["Subscribe with Stripe", "OpenWork Models"],
          },
        });
      },
    },
  ],
};
