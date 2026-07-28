import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denWebUrl } from "./lib/den-web.mjs";

const FLOW_ID = "den-onboarding-two-steps";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEN_WEB_URL = denWebUrl();
const OWNER_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const OWNER_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const ONBOARDING_PATH = "/dashboard/onboarding";
const INFERENCE_PATH = "/dashboard/inference";
const BYOK_PATH = "/dashboard/custom-llm-providers";
const INSTALLED_KEY = "openwork:onboarding:app-installed";
const STEP_SECTIONS = `document.querySelectorAll('[data-testid^="onboarding-step-"]')`;
// A hosted owner with more than one workspace lands on the chooser first, and
// picking one sends them to the dashboard root. The workspace only sticks once
// the sidebar shows the membership, so wait for that before any deep link.
const WORKSPACE_READY = `(() => {
  const chooser = document.querySelector('[data-testid="org-chooser-list"]');
  if (chooser) {
    chooser.querySelector('button')?.click();
    return false;
  }
  const sidebar = [...document.querySelectorAll('aside')].find((element) => getComputedStyle(element).display !== 'none');
  return (sidebar?.innerText ?? '').includes('Owner');
})()`;

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : JSON.stringify(actual).slice(0, 1_200),
  });
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : `. Actual: ${JSON.stringify(actual).slice(0, 600)}`}`);
}

/**
 * Signs in from a clean session. Local rather than shared because a hosted
 * (multi-org) owner lands on the workspace chooser, which the shared helper
 * does not click through.
 */
async function enterDashboard(ctx) {
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(DEN_WEB_URL)}; return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000 });
  await ctx.eval(
    `fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true).catch(() => true)`,
    { awaitPromise: true },
  );
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(DEN_WEB_URL)}; return true; })()`);
  await ctx.waitFor(`Boolean(document.querySelector('input[type="email"]'))`, { timeoutMs: 30_000, label: "sign-in card" });
  await ctx.fill('input[type="email"]', OWNER_EMAIL);
  await ctx.eval(`(() => { document.querySelector('button[type="submit"]')?.click(); return true; })()`);
  await ctx.waitFor(`Boolean(document.querySelector('input[type="password"]'))`, { timeoutMs: 20_000, label: "password step" });
  await ctx.fill('input[type="password"]', OWNER_PASSWORD);
  await ctx.eval(`(() => { document.querySelector('button[type="submit"]')?.click(); return true; })()`);
  await ctx.waitFor("window.location.pathname.startsWith('/dashboard')", { timeoutMs: 60_000, label: "signed in" });
  await ctx.waitFor(WORKSPACE_READY, { timeoutMs: 60_000, label: "workspace ready" });
}

async function openOnboarding(ctx) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await ctx.eval(`(() => { window.location.href = ${JSON.stringify(`${DEN_WEB_URL}${ONBOARDING_PATH}`)}; return true; })()`);
    await ctx.waitFor(`window.location.pathname === ${JSON.stringify(ONBOARDING_PATH)}`, {
      timeoutMs: 30_000,
      label: "setup route",
    });
    try {
      await ctx.waitFor(`${STEP_SECTIONS}.length > 0`, { timeoutMs: 20_000, label: "setup steps rendered" });
      return;
    } catch (error) {
      // A reload can bounce back to the workspace chooser; settle it and retry.
      ctx.log(`Setup did not render on attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
      await ctx.waitFor(WORKSPACE_READY, { timeoutMs: 60_000, label: "workspace ready" });
    }
  }
  await ctx.waitFor(`${STEP_SECTIONS}.length > 0`, { timeoutMs: 20_000, label: "setup steps rendered" });
}

/** The install flag is browser-local, so a rerun has to start from "not installed". */
async function forgetInstalledFlag(ctx) {
  await ctx.eval(`(() => { localStorage.removeItem(${JSON.stringify(INSTALLED_KEY)}); return true; })()`);
}

function stepHeading(step) {
  return `(() => {
    const section = document.querySelector('[data-testid="onboarding-step-${step}"]');
    return (section?.firstElementChild?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  })()`;
}

export default {
  id: FLOW_ID,
  title: "Cloud setup is two steps: install the desktop app, then turn on a model",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_API_URL"],
  steps: [
    {
      name: "Setup asks for exactly two things",
      run: async (ctx) => {
        await ctx.prove("A workspace owner opening setup sees two steps and no marketplace step", {
          voiceover: vo[0],
          action: async () => {
            await enterDashboard(ctx);
            await forgetInstalledFlag(ctx);
            await openOnboarding(ctx);
          },
          assert: async () => {
            const headings = [await ctx.eval(stepHeading("download")), await ctx.eval(stepHeading("models"))];
            witness(
              ctx,
              await ctx.eval(`${STEP_SECTIONS}.length`) === 2
                && headings[0].startsWith("Step 1 of 2Install the desktop app")
                && headings[1].startsWith("Step 2 of 2Turn on a model"),
              "Setup renders exactly two steps: install the app, then turn on a model",
              headings,
            );
            await ctx.expectText("Install the desktop app");
            await ctx.expectText("Turn on a model");
            await ctx.expectNoText("Stock your team marketplace");
            await ctx.expectNoText("steps done");
          },
          screenshot: {
            name: "two-step-setup",
            claim: "Setup opens on two steps — install the desktop app, then turn on a model.",
            requireText: ["STEP 1 OF 2", "Install the desktop app", "STEP 2 OF 2", "Turn on a model"],
            rejectText: ["Stock your team marketplace", "steps done", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "The install step is the workspace installer and it remembers",
      run: async (ctx) => {
        await ctx.prove("Step one hands out the workspace installer, and marking it installed sticks", {
          voiceover: vo[1],
          action: async () => {
            await ctx.clickText("I've already installed it");
            await ctx.waitFor(`${stepHeading("download")}.includes('Done')`, { timeoutMs: 15_000, label: "step one done" });
            await openOnboarding(ctx);
            await ctx.waitFor(`${stepHeading("download")}.includes('Done')`, { timeoutMs: 15_000, label: "step one still done after reload" });
          },
          assert: async () => {
            const installer = await ctx.eval(`(() => {
              const section = document.querySelector('[data-testid="onboarding-step-download"]');
              return {
                heading: section?.querySelector('h2')?.textContent?.trim() ?? '',
                actions: [...(section?.querySelectorAll('button') ?? [])].map((button) => button.textContent?.trim() ?? ''),
              };
            })()`);
            witness(
              ctx,
              installer.heading === "Download for this workspace"
                && installer.actions.includes("Open install page")
                && installer.actions.includes("Copy install link"),
              "Step one is the shared workspace installer card, not a bespoke download button",
              installer,
            );
            witness(
              ctx,
              await ctx.eval(`localStorage.getItem(${JSON.stringify(INSTALLED_KEY)})`) === "1",
              "Marking the app installed survives a reload",
              await ctx.eval(stepHeading("download")),
            );
            await ctx.expectNoText("I've already installed it");
          },
          screenshot: {
            name: "install-step-done",
            claim: "Step one is the workspace installer, and it stays marked Done after a reload.",
            requireText: ["Download for this workspace", "Open install page", "Copy install link", "Done"],
            rejectText: ["I've already installed it", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Two ways to turn on a model",
      run: async (ctx) => {
        await ctx.prove("Step two offers OpenWork Models or the owner's own provider key", {
          voiceover: vo[2],
          action: async () => {
            await ctx.waitFor(
              `Boolean(document.querySelector('[data-testid="onboarding-step-models"] a'))`,
              { timeoutMs: 20_000, label: "model choices" },
            );
            await ctx.eval(`(() => {
              document.querySelector('[data-testid="onboarding-step-models"]')?.scrollIntoView({ block: 'center' });
              return true;
            })()`);
            await ctx.waitFor("document.querySelector('main.overflow-y-auto').scrollTop > 0", {
              timeoutMs: 10_000,
              label: "model choices scrolled into view",
            });
          },
          assert: async () => {
            const choices = await ctx.eval(`(() => {
              const section = document.querySelector('[data-testid="onboarding-step-models"]');
              return {
                links: [...(section?.querySelectorAll('a') ?? [])].map((link) => ({
                  label: link.textContent?.trim() ?? '',
                  href: link.getAttribute('href') ?? '',
                })),
                brands: [...(section?.querySelectorAll('svg[aria-label]') ?? [])].map((svg) => svg.getAttribute('aria-label')),
                recommended: section?.querySelector('a[href$="/inference"]')?.closest('div')?.textContent?.includes('Recommended') ?? false,
              };
            })()`);
            witness(
              ctx,
              choices.links.length === 2
                && choices.links.some((link) => link.label === "Use OpenWork Models" && link.href === INFERENCE_PATH)
                && choices.links.some((link) => link.label === "Add your own key" && link.href === BYOK_PATH),
              "Step two routes to OpenWork Models or to bring-your-own-key, and nowhere else",
              choices.links,
            );
            witness(
              ctx,
              ["OpenAI", "OpenRouter", "Anthropic"].every((brand) => choices.brands.includes(brand)),
              "The bring-your-own-key path names the providers a team already pays for",
              choices.brands,
            );
            witness(ctx, choices.recommended, "OpenWork Models is the recommended choice", choices.recommended);
          },
          screenshot: {
            name: "model-choices",
            claim: "Step two is two cards: OpenWork Models (recommended) or bring your own provider key.",
            requireText: ["OpenWork Models", "RECOMMENDED", "Bring your own key", "Add your own key"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "The recommended path lands on OpenWork Models",
      run: async (ctx) => {
        await ctx.prove("Following the recommended choice opens the workspace's OpenWork Models page", {
          voiceover: vo[3],
          action: async () => {
            await ctx.clickText("Use OpenWork Models");
            await ctx.waitFor(`window.location.pathname === ${JSON.stringify(INFERENCE_PATH)}`, {
              timeoutMs: 30_000,
              label: "OpenWork Models route",
            });
          },
          assert: async () => {
            witness(
              ctx,
              await ctx.eval("window.location.pathname") === INFERENCE_PATH,
              "The recommended choice navigates to the workspace models page",
              await ctx.eval("window.location.pathname"),
            );
            await ctx.expectText("Frontier intelligence");
            await ctx.expectNoText("STEP 1 OF 2");
          },
          screenshot: {
            name: "openwork-models-page",
            claim: "The recommended choice lands on OpenWork Models, where inference is switched on.",
            requireText: ["OpenWork Models", "Frontier intelligence"],
            rejectText: ["STEP 1 OF 2", "Something went wrong"],
            hashIncludes: "/inference",
          },
        });
      },
    },
  ],
};
