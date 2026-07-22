import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import {
  ORG_SETTINGS_PATH,
  adminEnsureFreshAuth,
  assertSignedIntoDen,
  clickSaveSettings,
  denFetch,
  ensureRendererMounted,
  ensureWorkspaceReady,
  memberRefresh,
  navigateAdminOrgSettings,
  openAdminPanel,
  panelEval,
  setIconUrlInPanel,
  sleep,
  waitForBrandIconState,
  waitForDesktopConfig,
  waitForPanel,
  waitUntil,
} from "./desktop-brand-icon.flow.mjs";

// Narration is loaded from the approved script (evals/voiceovers/brand-icon-validation.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("brand-icon-validation");

const BAD_ICON_URL = "https://en.wikipedia.org/wiki/Logo";
const BRANDFETCH_ICON_URL = "https://cdn.brandfetch.io/idFKBn8taQ/w/520/h/520/idpRgKhcaI.png?c=1dxbfHSJFAPEGdCLU4o5B";
const ERROR_TEXT = "That link didn't return an image — it may redirect to a web page instead of the file (some logo CDNs block hotlinking). Use a direct PNG URL.";
const ERROR_SNIPPET = "didn't return an image";
const SUCCESS_TEXT = "Workspace settings updated.";

async function ensureMemberReady(ctx) {
  await ensureRendererMounted(ctx);
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 30_000,
    label: "window.__openworkControl",
  });
  await ctx.ensureLightMode();
  await assertSignedIntoDen(ctx);
  await waitUntil(ctx, "desktop Den auth provider signed in", async () => {
    const status = await ctx.control("auth.status", {}).catch(() => null);
    return status?.status !== "checking" && status?.user ? status : null;
  }, { timeoutMs: 30_000 });

  await ensureWorkspaceReady(ctx);
}

/**
 * Scroll the Brand Appearance card into view on the panel right before a
 * sandbox (OS-level) screenshot. Scroll position doesn't reliably survive
 * earlier waits/re-renders, and an OS-level capture shows whatever is
 * actually on screen — so this must run immediately before each capture,
 * not just once after filling a field.
 */
async function scrollBrandCardIntoView(ctx) {
  await panelEval(ctx, `(() => {
    const heading = Array.from(document.querySelectorAll('h1,h2,h3,p,span')).find((element) =>
      (element.textContent ?? '').includes('Brand Appearance')
    );
    heading?.scrollIntoView({ block: 'center' });
    return Boolean(heading);
  })()`).catch(() => undefined);
  await sleep(200);
}

async function getIconUrlInputValue(ctx) {
  return panelEval(ctx, `(() => {
    const input = Array.from(document.querySelectorAll('input')).find((candidate) => /icon/i.test(candidate.placeholder || ''));
    if (!input) throw new Error('Icon URL input not found');
    return input.value;
  })()`);
}

async function waitForPanelText(ctx, text, label) {
  return waitForPanel(ctx, `document.body.innerText.includes(${JSON.stringify(text)})`, {
    timeoutMs: 30_000,
    label,
  });
}

async function panelTextState(ctx) {
  return panelEval(ctx, `(() => {
    const text = document.body.innerText;
    return {
      hasError: text.includes(${JSON.stringify(ERROR_TEXT)}),
      hasSuccess: text.includes(${JSON.stringify(SUCCESS_TEXT)}),
    };
  })()`);
}

export default {
  id: "brand-icon-validation",
  title: "Brand Icon URL rejects web pages loudly and accepts real logo image links",
  kind: "user-facing",
  spec: "evals/voiceovers/brand-icon-validation.md",
  // OPENWORK_EVAL_DAYTONA_SANDBOX is required (not optional, unlike
  // desktop-brand-icon): the admin panel's Icon URL field lives in an
  // embedded browser-panel WebContentsView, which no CDP target's
  // Page.captureScreenshot can see. Only a real OS-level (X11) screen grab
  // inside the sandbox shows its actual content, so without a sandbox this
  // flow would either fail with a "duplicate blank screenshot" or need to
  // skip the visual proof entirely — cleaner to just require it.
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DAYTONA_SANDBOX"],
  steps: [
    {
      name: "setup",
      run: async (ctx) => {
        await ensureMemberReady(ctx);
        await denFetch(ctx, "/v1/org", {
          method: "PATCH",
          body: JSON.stringify({ brandIconUrl: null }),
        });
        await memberRefresh(ctx);
        await waitForDesktopConfig(ctx, "server brandIconUrl cleared for validation flow", (config) => !config.brandIconUrl);
        await waitForBrandIconState(ctx, "brand icon clear before validation flow", (state) => state?.applied === false, 30_000, { refresh: true });
        ctx.log("Setup complete: desktop is signed in and brand icon is clear.");
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Org owner can enter a non-image web page URL in the Icon URL field", {
          voiceover: vo[0],
          action: async () => {
            await openAdminPanel(ctx);
            await adminEnsureFreshAuth(ctx);
            await navigateAdminOrgSettings(ctx);
            await setIconUrlInPanel(ctx, BAD_ICON_URL);
            await waitForPanel(ctx, `(() => {
              const input = Array.from(document.querySelectorAll('input')).find((candidate) => /icon/i.test(candidate.placeholder || ''));
              return input?.value === ${JSON.stringify(BAD_ICON_URL)};
            })()`, { timeoutMs: 10_000, label: "bad Icon URL reflected in input" });
          },
          assert: async () => {
            const value = await getIconUrlInputValue(ctx);
            ctx.assert(value === BAD_ICON_URL, `Expected Icon URL input to contain ${BAD_ICON_URL}, got ${value}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Admin Icon URL input contains the pasted non-image page URL", actual: value });
            await scrollBrandCardIntoView(ctx);
          },
          screenshot: {
            name: "frame-1-admin-bad-icon-url-entered",
            sandboxCapture: true,
            textTargetUrlIncludes: ORG_SETTINGS_PATH,
            requireText: ["Brand Appearance", "Icon URL"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Saving a web page URL shows the not-an-image error and does not persist it", {
          voiceover: vo[1],
          action: async () => {
            await sleep(300);
            await clickSaveSettings(ctx);
            await waitForPanelText(ctx, ERROR_TEXT, "brand icon not-an-image error banner");
          },
          assert: async () => {
            const textState = await panelTextState(ctx);
            ctx.assert(textState?.hasError === true, "Expected the admin panel to show the not-an-image brand icon error.");
            const { body } = await denFetch(ctx, "/v1/me/desktop-config");
            ctx.assert(!body.brandIconUrl, `Expected bad Icon URL not to persist, got ${body.brandIconUrl}`);
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: "Admin panel shows the not-an-image message and Den API has no brandIconUrl",
              actual: JSON.stringify({ hasError: textState?.hasError, brandIconUrl: body.brandIconUrl ?? null }),
            });
            await scrollBrandCardIntoView(ctx);
          },
          screenshot: {
            name: "frame-2-admin-bad-icon-url-rejected",
            sandboxCapture: true,
            textTargetUrlIncludes: ORG_SETTINGS_PATH,
            requireText: [ERROR_SNIPPET],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Saving a real Brandfetch PNG succeeds and persists the Icon URL", {
          voiceover: vo[2],
          action: async () => {
            await setIconUrlInPanel(ctx, "");
            await waitForPanel(ctx, `(() => {
              const input = Array.from(document.querySelectorAll('input')).find((candidate) => /icon/i.test(candidate.placeholder || ''));
              return input?.value === '';
            })()`, { timeoutMs: 10_000, label: "Icon URL cleared before Brandfetch value" });
            await setIconUrlInPanel(ctx, BRANDFETCH_ICON_URL);
            await waitForPanel(ctx, `(() => {
              const input = Array.from(document.querySelectorAll('input')).find((candidate) => /icon/i.test(candidate.placeholder || ''));
              return input?.value === ${JSON.stringify(BRANDFETCH_ICON_URL)};
            })()`, { timeoutMs: 10_000, label: "Brandfetch Icon URL reflected in input" });
            await sleep(300);
            await clickSaveSettings(ctx);
            // NOTE: this screen has a pre-existing, orthogonal bug — ANY
            // successful save (verified with a save unrelated to brand icon
            // entirely, e.g. toggling the SSO checkbox) never renders the
            // "Workspace settings updated." confirmation text, even though
            // the PATCH genuinely returns 200 with the correct persisted
            // state (independently confirmed via direct fetch + server
            // truth). Not caused by this change and out of scope to fix
            // here — the load-bearing proof for "it worked" is server
            // truth (denFetch below) plus the absence of the not-an-image
            // error, not this banner.
            await waitForPanel(ctx, `!document.body.innerText.includes(${JSON.stringify(ERROR_TEXT)})`, {
              timeoutMs: 15_000,
              label: "not-an-image error absent after saving a valid icon URL",
            });
            await waitForDesktopConfig(ctx, "server brandIconUrl persisted to Brandfetch URL", (body) => body.brandIconUrl === BRANDFETCH_ICON_URL);
          },
          assert: async () => {
            const textState = await panelTextState(ctx);
            ctx.assert(textState?.hasError === false, "Expected the not-an-image error to be absent after saving the valid icon URL.");
            const { body: config } = await denFetch(ctx, "/v1/me/desktop-config");
            ctx.assert(config.brandIconUrl === BRANDFETCH_ICON_URL, `Expected brandIconUrl=${BRANDFETCH_ICON_URL}, got ${config.brandIconUrl}`);
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: "No icon error in the admin panel and Den API returns the Brandfetch brandIconUrl (server truth — this screen's success banner has a pre-existing, unrelated bug that swallows it on every save)",
              actual: JSON.stringify({ hasError: textState?.hasError, brandIconUrl: config.brandIconUrl }),
            });
            await scrollBrandCardIntoView(ctx);
          },
          screenshot: {
            name: "frame-3-admin-good-icon-url-saved",
            sandboxCapture: true,
            textTargetUrlIncludes: ORG_SETTINGS_PATH,
            rejectText: [ERROR_SNIPPET],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        let appliedState = null;
        await ctx.prove("Running teammate desktop applies the saved company logo as the app icon", {
          voiceover: vo[3],
          action: async () => {
            await memberRefresh(ctx);
            appliedState = await waitForBrandIconState(ctx, "member app applied Brandfetch brand icon", (state) =>
              state?.applied === true && state?.sourceUrl === BRANDFETCH_ICON_URL,
            30_000, { refresh: true });
            await ctx.navigateHash("/session");
            await ctx.waitForText("Search sessions", { timeoutMs: 30_000 });
          },
          assert: async () => {
            ctx.assert(appliedState?.applied === true, `Expected brand icon applied, got ${JSON.stringify(appliedState)}`);
            ctx.assert(appliedState?.sourceUrl === BRANDFETCH_ICON_URL, `Expected sourceUrl=${BRANDFETCH_ICON_URL}, got ${appliedState?.sourceUrl}`);
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: "Electron brandIcon.getState reports the saved Brandfetch URL is applied",
              actual: JSON.stringify(appliedState),
            });
          },
          screenshot: {
            name: "frame-4-member-icon-applied",
            requireText: ["Search sessions"],
          },
        });
      },
    },
  ],
};
