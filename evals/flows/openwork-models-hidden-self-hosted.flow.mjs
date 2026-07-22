import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script
// (evals/voiceovers/openwork-models-hidden-self-hosted.md).
// The runner fails this flow if the narration drifts from that script.
const FLOW_ID = "openwork-models-hidden-self-hosted";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const SELF_HOSTED_BASE_URL = "https://den.internal.acme.test";
const STARTUP_DIALOG_TITLE = "Use OpenWork Models without API keys";
const DEFAULT_ORG_SERVER_TEXT = "Using standard OpenWork Cloud.";
const EDITOR_SELECTOR = '[contenteditable="true"][data-lexical-editor="true"]';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForControl(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 90_000, label: "OpenWork control API" });
}

async function reloadApp(ctx) {
  await ctx.eval("(() => { location.reload(); return true; })()");
  await sleep(1_500);
  await waitForControl(ctx);
}

/**
 * Click a button by exact trimmed text through its React onClick prop.
 * Base UI buttons do not always react to bare DOM .click() under CDP.
 */
async function clickReact(ctx, text) {
  const result = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll("button")].find((el) => (el.textContent ?? "").trim() === ${JSON.stringify(text)} && !el.disabled);
    if (!button) return "not found";
    const propsKey = Object.keys(button).find((k) => k.startsWith("__reactProps$"));
    if (propsKey && button[propsKey]?.onClick) {
      button[propsKey].onClick({ preventDefault: () => {}, stopPropagation: () => {}, currentTarget: button, target: button });
      return "react";
    }
    button.click();
    return "dom";
  })()`);
  ctx.assert(result !== "not found", `Button not found: ${text}`);
}

/** Skip through first-run onboarding overlays (provider step + attribution). */
async function dismissOnboardingOverlays(ctx) {
  const ATTRIBUTION_TITLE = "How did you hear about OpenWork?";
  if (await ctx.hasText("Skip and use the free model")) {
    await clickReact(ctx, "Skip and use the free model");
    // The attribution step follows the provider choice; wait for it (or for
    // onboarding to finish straight into a session route).
    await ctx.waitFor(
      `document.body.innerText.includes(${JSON.stringify(ATTRIBUTION_TITLE)}) || location.hash.includes("/session") || location.hash.includes("/workspace/")`,
      { timeoutMs: 20_000, label: "attribution step or session after provider skip" },
    ).catch(() => {});
  }
  if (await ctx.hasText(ATTRIBUTION_TITLE)) {
    await clickReact(ctx, "Skip");
    await ctx.waitFor(`!document.body.innerText.includes(${JSON.stringify(ATTRIBUTION_TITLE)})`, {
      timeoutMs: 15_000,
      label: "attribution step dismissed",
    }).catch(() => {});
  }
}

/**
 * Idempotent workspace/session bootstrap. Fresh sandboxes land on the welcome
 * route; reruns land straight in a session. Creating through the real modal
 * uses the documented React-fiber folder injection (native pickers cannot run
 * headless) — labeled as setup, all proof frames afterwards are user-visible.
 */
async function ensureWorkspaceSession(ctx) {
  await waitForControl(ctx);
  const workspaceDir = ctx.env.OPENWORK_EVAL_WORKSPACE_DIR?.trim() || "/workspace/hello";

  // A previous (failed) run can leave the first-run overlays open; clear them
  // before deciding which route we are on.
  await dismissOnboardingOverlays(ctx);

  const onWelcome = await ctx.eval(`(() => {
    const text = document.body.innerText;
    return location.hash.includes("/welcome") || text.includes("Pick a folder to get started");
  })()`);

  if (onWelcome) {
    // Dev builds expose a manual folder input on the welcome page exactly for
    // headless/sandbox runs where the native folder picker cannot open.
    await ctx.waitFor(`Boolean(document.querySelector('input[placeholder="/workspace/my-project"]'))`, {
      timeoutMs: 15_000,
      label: "manual folder input on welcome page",
    });
    await ctx.fill('input[placeholder="/workspace/my-project"]', workspaceDir);
    await ctx.waitFor(`(() => {
      const button = [...document.querySelectorAll("button")].find((el) => (el.textContent ?? "").trim() === "Use this folder");
      return Boolean(button && !button.disabled);
    })()`, { timeoutMs: 10_000, label: "enabled Use this folder button" });
    await clickReact(ctx, "Use this folder");

    // First-run onboarding after creation: provider step, then attribution.
    await ctx.waitFor(`(() => {
      const text = document.body.innerText;
      return text.includes("Power your first task") || text.includes("Skip this part") || location.hash.includes("/session");
    })()`, { timeoutMs: 120_000, label: "post-create onboarding surface" });
    await dismissOnboardingOverlays(ctx);
  }

  await ctx.waitFor('location.hash.includes("/session") || location.hash.includes("/workspace/")', {
    timeoutMs: 120_000,
    label: "workspace session route",
  });
  if (await ctx.eval('location.hash.includes("/settings")')) {
    await ctx.navigateHash("/");
    await ctx.waitFor('location.hash.includes("/session") || location.hash.includes("/workspace/")', {
      timeoutMs: 60_000,
      label: "session route after leaving settings",
    });
  }
  if (!(await ctx.eval(`Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}))`))) {
    if (await ctx.hasText("New session")) {
      await ctx.clickText("New session", { timeoutMs: 10_000 });
    }
  }
  await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}))`, {
    timeoutMs: 90_000,
    label: "composer editor",
  });
}

/** Idempotent: make sure the app points at the default hosted control plane. */
async function ensureHostedControlPlane(ctx) {
  await ctx.navigateHash("/settings/advanced");
  await ctx.waitForText("Organization server URL", { timeoutMs: 30_000 });
  if (!(await ctx.hasText(DEFAULT_ORG_SERVER_TEXT))) {
    await ctx.clickText("Clear server configuration", { selector: "button", timeoutMs: 10_000 });
    await ctx.waitForText("Click again to clear", { timeoutMs: 10_000 });
    await ctx.clickText("Click again to clear", { selector: "button", timeoutMs: 10_000 });
    await ctx.waitForText(DEFAULT_ORG_SERVER_TEXT, { timeoutMs: 15_000 });
    await reloadApp(ctx);
    await ctx.navigateHash("/settings/advanced");
    await ctx.waitForText(DEFAULT_ORG_SERVER_TEXT, { timeoutMs: 30_000 });
  }
}

async function openModelPicker(ctx) {
  await ctx.waitFor(`Boolean(document.querySelector('button[aria-label="Change model"]'))`, {
    timeoutMs: 30_000,
    label: "model picker trigger",
  });
  await ctx.eval(`(() => {
    document.querySelector('button[aria-label="Change model"]').click();
    return true;
  })()`);
  await ctx.waitFor(`Boolean(document.querySelector('input[placeholder="Search models..."]'))`, {
    timeoutMs: 15_000,
    label: "model picker popover",
  });
}

async function closeModelPicker(ctx) {
  await ctx.eval(`(() => {
    const input = document.querySelector('input[placeholder="Search models..."]');
    (input ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  })()`);
  await sleep(500);
}

/**
 * Open the provider choice step through the real user journey: reset the
 * one-shot onboarding latch (labeled setup shortcut), then create a workspace
 * from the welcome page. The step renders right after creation.
 */
async function openProviderStepViaWorkspaceSetup(ctx, workspaceDir) {
  // Reset the one-shot onboarding latch, then reload so the in-memory
  // preferences store re-reads it — otherwise the welcome route immediately
  // redirects back to the session. Navigate to the welcome page only after
  // boot settles (the boot sequence restores the last session route and would
  // otherwise race the hash we set).
  await ctx.eval(`(() => {
    const raw = localStorage.getItem("openwork.preferences");
    const prefs = raw ? JSON.parse(raw) : {};
    prefs.hasCompletedOnboarding = false;
    localStorage.setItem("openwork.preferences", JSON.stringify(prefs));
    return true;
  })()`);
  await reloadApp(ctx);
  await ctx.waitFor('location.hash.includes("/session") || location.hash.includes("/workspace/") || location.hash.includes("/welcome")', {
    timeoutMs: 60_000,
    label: "app settled after onboarding-latch reload",
  });
  await sleep(2_000);
  await ctx.navigateHash("/welcome");
  await ctx.waitFor(`Boolean(document.querySelector('input[placeholder="/workspace/my-project"]'))`, {
    timeoutMs: 30_000,
    label: "manual folder input on welcome page",
  });
  await sleep(1_000);
  try {
    await ctx.fill('input[placeholder="/workspace/my-project"]', workspaceDir);
  } catch {
    await sleep(1_500);
    await ctx.fill('input[placeholder="/workspace/my-project"]', workspaceDir);
  }
  await ctx.waitFor(`(() => {
    const button = [...document.querySelectorAll("button")].find((el) => (el.textContent ?? "").trim() === "Use this folder");
    return Boolean(button && !button.disabled);
  })()`, { timeoutMs: 10_000, label: "enabled Use this folder button" });
  await clickReact(ctx, "Use this folder");
  await ctx.waitForText("Power your first task", { timeoutMs: 120_000 });
}

/** Setup shortcut (labeled): reset the one-shot latches this flow proves. */
async function resetPromoLatches(ctx, { startupShown }) {
  await ctx.eval(`(() => {
    const raw = localStorage.getItem("openwork.preferences");
    const prefs = raw ? JSON.parse(raw) : {};
    delete prefs.providerStepCompleted;
    localStorage.setItem("openwork.preferences", JSON.stringify(prefs));
    if (${JSON.stringify(Boolean(startupShown))}) {
      localStorage.setItem("openwork.openworkModelsPromo.startupShown", "1");
    } else {
      localStorage.removeItem("openwork.openworkModelsPromo.startupShown");
    }
    localStorage.removeItem("openwork.openworkModelsPromo.hidden");
    localStorage.removeItem("openwork.openworkModelsPromo.lastShownAt");
    return true;
  })()`);
}

export default {
  id: FLOW_ID,
  title: "Self-hosted control planes hide every OpenWork Models upsell surface; hosted keeps them",
  kind: "user-facing",
  steps: [
    {
      name: "Setup — session ready on the hosted control plane",
      run: async (ctx) => {
        await ensureWorkspaceSession(ctx);
        await ensureHostedControlPlane(ctx);
        // Labeled setup: pre-mark the startup dialog as shown so it cannot
        // cover the hosted baseline frames (it gets its own negative proof on
        // the self-hosted side); reset the promo + provider-step latches this
        // flow is about to prove.
        await resetPromoLatches(ctx, { startupShown: true });
        await reloadApp(ctx);
        await ensureWorkspaceSession(ctx);
        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "Setup: session is ready on the default hosted OpenWork Cloud control plane with promo latches reset (startup dialog latch pre-marked for the baseline phase).",
        });
      },
    },
    {
      name: "Frame 1 — hosted model picker pitches OpenWork Models",
      run: async (ctx) => {
        await ctx.prove("On the hosted control plane the model picker shows the OpenWork Models promo group", {
          voiceover: vo[0],
          action: async () => {
            await openModelPicker(ctx);
            await ctx.waitForText("OpenWork hosted", { timeoutMs: 15_000 });
          },
          assert: async () => {
            await ctx.expectText("OpenWork Models");
            await ctx.expectText("OpenWork hosted");
          },
          screenshot: {
            name: "hosted-model-picker-promo",
            requireText: ["OpenWork Models", "OpenWork hosted"],
          },
        });
        await closeModelPicker(ctx);
      },
    },
    {
      name: "Frame 2 — hosted Settings > AI shows the subscribe banner",
      run: async (ctx) => {
        await ctx.prove("On the hosted control plane Settings > AI offers the OpenWork Models subscription", {
          voiceover: vo[1],
          action: async () => {
            await ctx.navigateHash("/settings/ai");
            await ctx.waitForText("OpenWork Models", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("OpenWork Models");
            await ctx.expectText("Subscribe");
            await ctx.expectText("Hosted frontier models for OpenWork tasks without managing provider API keys.");
          },
          screenshot: {
            name: "hosted-settings-ai-subscribe",
            requireText: ["OpenWork Models", "Subscribe"],
            hashIncludes: "/settings/ai",
          },
        });
      },
    },
    {
      name: "Frame 3 — hosted workspace setup offers Use OpenWork Models",
      run: async (ctx) => {
        await ctx.prove("On the hosted control plane the workspace-setup provider step includes the Use OpenWork Models option", {
          voiceover: vo[2],
          action: async () => {
            await openProviderStepViaWorkspaceSetup(ctx, "/workspace/hello-hosted");
          },
          assert: async () => {
            await ctx.expectText("Power your first task");
            await ctx.expectText("Use OpenWork Models");
            await ctx.expectText("Bring your own API key");
            await ctx.expectText("Skip and use the free model");
          },
          screenshot: {
            name: "hosted-provider-step-openwork-models",
            requireText: ["Power your first task", "Use OpenWork Models", "Skip and use the free model"],
          },
        });
        await dismissOnboardingOverlays(ctx);
        await ensureWorkspaceSession(ctx);
      },
    },
    {
      name: "Frame 4 — point the desktop at a self-hosted organization server",
      run: async (ctx) => {
        await ctx.prove("Saving a self-hosted organization server URL switches the desktop's control plane", {
          voiceover: vo[3],
          action: async () => {
            await ctx.navigateHash("/settings/advanced");
            await ctx.waitForText("Organization server URL", { timeoutMs: 30_000 });
            await ctx.fill("label input", SELF_HOSTED_BASE_URL);
            await ctx.clickText("Save", { selector: "button" });
            await ctx.waitForText(`Current organization server: ${SELF_HOSTED_BASE_URL}`, { timeoutMs: 15_000 });
          },
          assert: async () => {
            await ctx.expectText(`Current organization server: ${SELF_HOSTED_BASE_URL}`);
          },
          screenshot: {
            name: "self-hosted-server-saved",
            requireText: ["Organization server URL", `Current organization server: ${SELF_HOSTED_BASE_URL}`],
            hashIncludes: "/settings/advanced",
          },
        });
        // Labeled setup: clear the startup-dialog latch so the self-hosted
        // phase proves it never auto-opens, then reload so every surface
        // re-reads the control plane.
        await resetPromoLatches(ctx, { startupShown: false });
        await ctx.eval(`(() => { window.location.hash = "#/"; return true; })()`);
        await reloadApp(ctx);
      },
    },
    {
      name: "Frame 5 — no startup pitch and no OpenWork Models in Settings > AI",
      run: async (ctx) => {
        await ctx.prove("Self-hosted: the startup dialog never auto-opens and Settings > AI drops every OpenWork Models row", {
          voiceover: vo[4],
          action: async () => {
            await ensureWorkspaceSession(ctx);
            // The startup promo schedules ~900ms after the workspace is ready;
            // give it several seconds to (not) appear before witnessing.
            await sleep(6_000);
            await ctx.expectNoText(STARTUP_DIALOG_TITLE);
            await ctx.navigateHash("/settings/ai");
            await ctx.waitForText("Connect provider", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectNoText("OpenWork Models");
            await ctx.expectNoText("Hosted frontier models");
          },
          screenshot: {
            name: "self-hosted-settings-ai-clean",
            requireText: ["Connect provider"],
            rejectText: ["OpenWork Models", "Subscribe"],
            hashIncludes: "/settings/ai",
          },
        });
      },
    },
    {
      name: "Frame 6 — self-hosted model picker has no promo group",
      run: async (ctx) => {
        await ctx.prove("Self-hosted: the model picker lists only real providers, no OpenWork Models group", {
          voiceover: vo[5],
          action: async () => {
            await ctx.navigateHash("/");
            await ensureWorkspaceSession(ctx);
            await openModelPicker(ctx);
          },
          assert: async () => {
            await ctx.expectNoText("OpenWork hosted");
            await ctx.expectNoText("OpenWork Models");
          },
          screenshot: {
            name: "self-hosted-model-picker-clean",
            requireText: ["All models"],
            rejectText: ["OpenWork Models", "OpenWork hosted"],
          },
        });
        await closeModelPicker(ctx);
      },
    },
    {
      name: "Frame 7 — self-hosted provider step has no OpenWork Models option",
      run: async (ctx) => {
        await ctx.prove("Self-hosted: the workspace-setup provider step only offers BYO key and the free model", {
          voiceover: vo[6],
          action: async () => {
            await openProviderStepViaWorkspaceSetup(ctx, "/workspace/hello-selfhosted");
          },
          assert: async () => {
            await ctx.expectText("Power your first task");
            await ctx.expectText("Bring your own API key");
            await ctx.expectText("Skip and use the free model");
            await ctx.expectNoText("Use OpenWork Models");
          },
          screenshot: {
            name: "self-hosted-provider-step-clean",
            requireText: ["Power your first task", "Bring your own API key", "Skip and use the free model"],
            rejectText: ["Use OpenWork Models"],
          },
        });
        await dismissOnboardingOverlays(ctx);
        await ensureWorkspaceSession(ctx);
      },
    },
    {
      name: "Frame 8 — clearing the server restores the hosted offer",
      run: async (ctx) => {
        await ctx.prove("Clearing the server configuration returns to OpenWork Cloud and the subscribe banner comes back", {
          voiceover: vo[7],
          action: async () => {
            await ctx.navigateHash("/settings/advanced");
            await ctx.waitForText("Clear server configuration", { timeoutMs: 30_000 });
            await ctx.clickText("Clear server configuration", { selector: "button" });
            await ctx.waitForText("Click again to clear", { timeoutMs: 10_000 });
            await ctx.clickText("Click again to clear", { selector: "button" });
            await ctx.waitForText(DEFAULT_ORG_SERVER_TEXT, { timeoutMs: 15_000 });
            await reloadApp(ctx);
            await ctx.navigateHash("/settings/ai");
            await ctx.waitForText("OpenWork Models", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("OpenWork Models");
            await ctx.expectText("Subscribe");
          },
          screenshot: {
            name: "hosted-restored-settings-ai",
            requireText: ["OpenWork Models", "Subscribe"],
            hashIncludes: "/settings/ai",
          },
        });
      },
    },
  ],
};
