import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "landing-posthog-prod-gate";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const COPY_BUTTON_SELECTOR = 'button[aria-label="Copy the agent setup prompt"]';
const POSTHOG_SCRIPT_MARKERS = ['id="posthog"', '"id":"posthog"'];
const POSTHOG_KEY_PREFIX = "phc_";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pageUrl(baseUrl) {
  return new URL("/", baseUrl).toString();
}

function recordAssertion(ctx, assertion, passed, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

function hasPosthogScriptMarker(html) {
  return POSTHOG_SCRIPT_MARKERS.some((marker) => html.includes(marker));
}

async function scanHomeHtml(baseUrl) {
  const response = await fetch(pageUrl(baseUrl));
  const html = await response.text();
  return {
    status: response.status,
    hasPosthogScript: hasPosthogScriptMarker(html),
    hasPosthogKeyPrefix: html.includes(POSTHOG_KEY_PREFIX),
  };
}

// The production-mode instance ships the real snippet with the production
// project key. Block PostHog's hosts so driving it in an eval never sends
// $pageview/autocapture to real analytics: the inline snippet still runs
// (window.posthog queue exists), but array.js and capture posts are dropped.
async function setPosthogNetworkBlocked(ctx, blocked) {
  if (!ctx.client?.send) {
    ctx.log("PostHog network block skipped: no raw CDP send method on context.");
    return;
  }
  try {
    await ctx.client.send("Network.enable", {});
    await ctx.client.send("Network.setBlockedURLs", { urls: blocked ? ["*posthog.com*"] : [] });
  } catch (error) {
    ctx.log(`PostHog network block ${blocked ? "enable" : "clear"} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function grantClipboardPermissions(ctx, baseUrl) {
  if (!ctx.client?.send) {
    ctx.log("Clipboard permission grant skipped: no raw CDP send method on context.");
    return;
  }

  const origin = new URL(baseUrl).origin;
  await ctx.client.send("Browser.grantPermissions", {
    origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  }).catch((error) => {
    ctx.log(`Clipboard permission grant skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function applyDesktopViewport(ctx) {
  if (!ctx.client?.send) {
    ctx.log("Desktop viewport skipped: no raw CDP send method on context.");
    return;
  }

  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  }).catch((error) => {
    ctx.log(`Desktop viewport skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function clickCopyButton(ctx) {
  const point = await ctx.eval(`(() => {
    const button = document.querySelector(${JSON.stringify(COPY_BUTTON_SELECTOR)});
    // "instant" bypasses the page's css scroll-behavior: smooth so the rect
    // below is measured after the scroll actually happened, not mid-animation.
    button.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = button.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  })()`);

  if (!ctx.client?.send) {
    await ctx.eval(`(() => {
      document.querySelector(${JSON.stringify(COPY_BUTTON_SELECTOR)}).click();
      return true;
    })()`);
    return;
  }

  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

export default {
  id: FLOW_ID,
  title: "Landing PostHog loads in production only",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_LANDING_URL", "OPENWORK_EVAL_LANDING_PROD_URL"],
  steps: [
    {
      name: "Dev server ships no PostHog, and the hero prompt still works",
      run: async (ctx) => {
        let htmlScan = null;
        let runtimeScan = null;
        let copyScan = null;

        await ctx.prove("Dev server ships no PostHog, and the hero prompt still works.", {
          voiceover: vo[0],
          action: async () => {
            await applyDesktopViewport(ctx);
            htmlScan = await scanHomeHtml(ctx.env.OPENWORK_EVAL_LANDING_URL);
            await ctx.eval(`location.href = ${JSON.stringify(pageUrl(ctx.env.OPENWORK_EVAL_LANDING_URL))}; true`);
            await ctx.waitFor(
              `Boolean(document.querySelector(${JSON.stringify(COPY_BUTTON_SELECTOR)}))`,
              { timeoutMs: 30_000, label: "hero prompt copy button on dev landing" },
            );
            runtimeScan = await ctx.eval(`(() => ({
              posthogUndefined: window.posthog === undefined,
              posthogScriptAbsent: document.getElementById("posthog") === null,
            }))()`);
            await grantClipboardPermissions(ctx, ctx.env.OPENWORK_EVAL_LANDING_URL);
            await clickCopyButton(ctx);
            await ctx.waitFor(
              `Boolean(document.querySelector('[data-feedback="true"]')) && window.posthog === undefined`,
              { timeoutMs: 10_000, label: "Hero prompt feedback without PostHog" },
            );
            copyScan = await ctx.eval(`(() => ({
              feedbackActive: Boolean(document.querySelector('[data-feedback="true"]')),
              posthogUndefined: window.posthog === undefined,
            }))()`);
            await sleep(400);
          },
          assert: async () => {
            ctx.recordEvidence({
              type: "output",
              name: "Dev homepage PostHog scan",
              text: JSON.stringify(htmlScan, null, 2),
            });
            recordAssertion(
              ctx,
              "Dev homepage HTML omits the PostHog inline script and project key prefix",
              htmlScan?.status === 200 && htmlScan.hasPosthogScript === false && htmlScan.hasPosthogKeyPrefix === false,
              htmlScan,
            );
            recordAssertion(
              ctx,
              "Dev browser runtime has no PostHog global and no inline script tag",
              runtimeScan?.posthogUndefined === true && runtimeScan.posthogScriptAbsent === true,
              runtimeScan,
            );
            recordAssertion(
              ctx,
              "Hero prompt enters feedback state while PostHog remains absent",
              copyScan?.feedbackActive === true && copyScan.posthogUndefined === true,
              copyScan,
            );
          },
          screenshot: {
            name: "dev-no-posthog-copied",
            requireText: ["Copied"],
          },
        });
      },
    },
    {
      name: "Production build ships PostHog",
      run: async (ctx) => {
        let htmlScan = null;
        let runtimeScan = null;

        await ctx.prove("Production build ships PostHog.", {
          voiceover: vo[1],
          action: async () => {
            await applyDesktopViewport(ctx);
            htmlScan = await scanHomeHtml(ctx.env.OPENWORK_EVAL_LANDING_PROD_URL);
            await setPosthogNetworkBlocked(ctx, true);
            await ctx.eval(`location.href = ${JSON.stringify(pageUrl(ctx.env.OPENWORK_EVAL_LANDING_PROD_URL))}; true`);
            await ctx.waitFor(
              `Boolean(document.querySelector(${JSON.stringify(COPY_BUTTON_SELECTOR)}))`,
              { timeoutMs: 30_000, label: "hero prompt copy button on production landing" },
            );
            await ctx.waitFor(
              `typeof window.posthog !== "undefined"`,
              { timeoutMs: 10_000, label: "PostHog global from production inline snippet" },
            );
            runtimeScan = await ctx.eval(`(() => ({
              posthogPresent: Boolean(window.posthog),
              posthogScriptPresent: Boolean(document.querySelector('script#posthog')) || Array.from(document.scripts).some((script) => (script.textContent || "").includes("posthog.init") && (script.textContent || "").includes("phc_")),
            }))()`);
          },
          assert: async () => {
            ctx.recordEvidence({
              type: "output",
              name: "Production homepage PostHog scan",
              text: JSON.stringify(htmlScan, null, 2),
            });
            recordAssertion(
              ctx,
              "Production homepage HTML includes the PostHog inline script and project key prefix",
              htmlScan?.status === 200 && htmlScan.hasPosthogScript === true && htmlScan.hasPosthogKeyPrefix === true,
              htmlScan,
            );
            recordAssertion(
              ctx,
              "Production browser runtime has the PostHog global and inline script tag",
              runtimeScan?.posthogPresent === true && runtimeScan.posthogScriptPresent === true,
              runtimeScan,
            );
          },
          screenshot: "prod-posthog-present",
        });

        await setPosthogNetworkBlocked(ctx, false);
      },
    },
  ],
};
