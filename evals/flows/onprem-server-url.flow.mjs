import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/onprem-server-url.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("onprem-server-url");

const ORG_URL = "https://openwork.acme-example.com";
const ORG_HOST = "openwork.acme-example.com";
const DEFAULT_DEN_BASE_URL = "https://app.openworklabs.com";
const DEFAULT_DEN_API_BASE_URL = "https://app.openworklabs.com/api/den";
const PROJECT_DIR = process.cwd();

async function setDesktopBootstrapConfig(ctx, config) {
  await ctx.waitFor(`Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)`, {
    timeoutMs: 60_000,
    label: "desktop bridge",
  });
  await ctx.eval(`(async () => {
    const config = ${JSON.stringify(config)};
    const persisted = await window.__OPENWORK_ELECTRON__.invokeDesktop("setDesktopBootstrapConfig", config);
    const baseUrl = persisted?.baseUrl || config.baseUrl;
    const apiBaseUrl = persisted?.apiBaseUrl || config.apiBaseUrl;
    localStorage.setItem("openwork.den.baseUrl", baseUrl);
    localStorage.setItem("openwork.den.apiBaseUrl", apiBaseUrl);
    localStorage.removeItem("openwork.den.authToken");
    localStorage.removeItem("openwork.den.activeOrgId");
    localStorage.removeItem("openwork.den.activeOrgSlug");
    localStorage.removeItem("openwork.den.activeOrgName");
    return persisted;
  })()`, { awaitPromise: true });
}

async function currentDenBaseUrls(ctx) {
  return ctx.eval(`(() => ({
    baseUrl: localStorage.getItem("openwork.den.baseUrl") || ${JSON.stringify(DEFAULT_DEN_BASE_URL)},
    apiBaseUrl: localStorage.getItem("openwork.den.apiBaseUrl") || ${JSON.stringify(DEFAULT_DEN_API_BASE_URL)},
  }))()`);
}

async function closeDialogs(ctx) {
  await ctx.eval(`(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  })()`);
}

function writeOnboardingPrefScript(completed) {
  return `(() => {
    let prefs = {};
    try {
      const raw = localStorage.getItem("openwork.preferences");
      prefs = raw ? JSON.parse(raw) : {};
    } catch {
      prefs = {};
    }
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) prefs = {};
    prefs.hasCompletedOnboarding = ${completed ? "true" : "false"};
    localStorage.setItem("openwork.preferences", JSON.stringify(prefs));
    return true;
  })()`;
}

async function resetToDefaultWelcome(ctx) {
  await closeDialogs(ctx);
  await setDesktopBootstrapConfig(ctx, {
    baseUrl: DEFAULT_DEN_BASE_URL,
    apiBaseUrl: DEFAULT_DEN_API_BASE_URL,
    requireSignin: false,
  });
  await ctx.eval(`(async () => {
    ${writeOnboardingPrefScript(false)};
    location.hash = "#/welcome";
    location.reload();
    return true;
  })()`, { awaitPromise: true });
  await ctx.waitForText("Using OpenWork on-premises?", { timeoutMs: 60_000 });
}

async function finishOnboardingEnoughForSettings(ctx) {
  const onWelcome = await ctx.hasText("Pick a folder to get started");
  const existingWorkspaceId = await ctx.eval(`(async () => {
    const invokeDesktop = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!invokeDesktop) return "";
    const list = await invokeDesktop("workspaceBootstrap").catch(() => null);
    return list?.selectedId || list?.activeId || list?.workspaces?.[0]?.id || "";
  })()`, { awaitPromise: true }).catch(() => "");
  if (onWelcome && existingWorkspaceId) {
    await ctx.eval(`${writeOnboardingPrefScript(true)}`);
    await ctx.navigateHash(`/workspace/${existingWorkspaceId}/settings/advanced`);
    await ctx.waitForText("Organization server", { timeoutMs: 60_000 });
    return;
  }

  if (onWelcome) {
    const hasManualFolder = await ctx.eval(`Boolean(document.querySelector('input[placeholder="/workspace/my-project"]'))`);
    if (hasManualFolder) {
      await ctx.fill('input[placeholder="/workspace/my-project"]', PROJECT_DIR);
      await ctx.clickText("Use this folder");
      const state = await ctx.waitFor(`(() => {
        const text = document.body.innerText;
        if (text.includes("Power your first task")) return "provider";
        if (text.includes("How did you hear about OpenWork?")) return "attribution";
        if (location.hash.includes("/workspace/") || location.hash.includes("#/session")) return "done";
        if (text.includes("OpenWork server is unavailable") || text.includes("Failed to create workspace")) return "fallback";
        return null;
      })()`, { timeoutMs: 120_000, label: "workspace creation or onboarding step" }).catch(() => "fallback");

      if (state === "provider") {
        await ctx.clickText("Skip and use the free model", { timeoutMs: 30_000 });
      }

      const attribution = await ctx.waitFor(`(() => {
        const text = document.body.innerText;
        if (text.includes("How did you hear about OpenWork?")) return "ready";
        if (!location.hash.startsWith("#/welcome")) return "done";
        return null;
      })()`, { timeoutMs: 30_000, label: "attribution or app route" }).catch(() => "fallback");

      if (attribution === "ready") {
        await ctx.clickText("Skip", { timeoutMs: 15_000 });
      }
    }
  }

  await ctx.eval(`${writeOnboardingPrefScript(true)}`);
  const advancedPath = await ctx.eval(`(() => {
    const prefix = "#/workspace/";
    if (!location.hash.startsWith(prefix)) return "/settings/advanced";
    const workspaceId = location.hash.slice(prefix.length).split("/")[0];
    return workspaceId ? "/workspace/" + workspaceId + "/settings/advanced" : "/settings/advanced";
  })()`);
  await ctx.navigateHash(advancedPath);
  await ctx.waitForText("Organization server", { timeoutMs: 60_000 });
}

async function assertAdvancedOrganizationServerFirst(ctx) {
  const firstSectionTitle = await ctx.eval(`(() => {
    const first = document.querySelector("[data-section]");
    return first?.querySelector("h3")?.textContent?.trim() ?? "";
  })()`);
  ctx.assert(firstSectionTitle === "Organization server", `Expected first Advanced section to be Organization server, got ${firstSectionTitle}`);
}

export default {
  id: "onprem-server-url",
  title: "Self-hosted users can set their organization server URL from welcome and Advanced settings",
  kind: "user-facing",
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The fresh welcome screen offers an on-premises server link under Get started", {
          voiceover: vo[0],
          action: async () => {
            await resetToDefaultWelcome(ctx);
          },
          assert: async () => {
            await ctx.expectText("Pick a folder to get started");
            await ctx.expectText("Using OpenWork on-premises?");
            await ctx.expectNoText(`Connected to ${ORG_HOST}`);
          },
          screenshot: {
            name: "frame-1",
            requireText: ["Pick a folder to get started", "Using OpenWork on-premises?"],
            rejectText: [`Connected to ${ORG_HOST}`, "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The on-premises link opens a focused organization server dialog", {
          voiceover: vo[1],
          action: async () => {
            await closeDialogs(ctx);
            await ctx.clickText("Using OpenWork on-premises?");
            await ctx.fill('input[placeholder="https://openwork.yourcompany.com"]', ORG_URL);
          },
          assert: async () => {
            await ctx.expectText("Connect to your organization's server");
            await ctx.expectText("Paste the server URL your IT team shared.");
            const saveEnabled = await ctx.eval(`(() => {
              const dialog = document.querySelector('[role="dialog"]');
              const save = Array.from(dialog?.querySelectorAll("button") ?? [])
                .find((button) => (button.textContent ?? "").trim() === "Save");
              return Boolean(save && !save.disabled);
            })()`);
            ctx.assert(saveEnabled, "Save should be enabled after a valid http(s) organization URL is pasted.");
          },
          screenshot: {
            name: "frame-2",
            requireText: ["Connect to your organization's server", "Cancel", "Save"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Saving the URL leaves a connected organization server state on welcome", {
          voiceover: vo[2],
          action: async () => {
            await ctx.clickText("Save", { selector: '[role="dialog"] button' });
            await ctx.waitForText(`Connected to ${ORG_HOST}`, { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText(`Connected to ${ORG_HOST}`);
            await ctx.expectText("Change");
            const stored = await ctx.eval(`localStorage.getItem("openwork.den.baseUrl")`);
            ctx.assert(stored === ORG_URL, `Expected localStorage control plane URL to be ${ORG_URL}, got ${stored}`);
          },
          screenshot: {
            name: "frame-3",
            requireText: [`Connected to ${ORG_HOST}`, "Change"],
            rejectText: ["Using OpenWork on-premises?", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Advanced settings shows Organization server first with the same saved URL", {
          voiceover: vo[3],
          action: async () => {
            await finishOnboardingEnoughForSettings(ctx);
          },
          assert: async () => {
            await ctx.expectText("Organization server");
            await ctx.expectText(`Current organization server: ${ORG_URL}`);
            await assertAdvancedOrganizationServerFirst(ctx);
            const inputValue = await ctx.eval(`document.querySelector('input[placeholder="${DEFAULT_DEN_BASE_URL}"]')?.value ?? ""`);
            ctx.assert(inputValue === ORG_URL, `Expected Advanced Organization server input to show ${ORG_URL}, got ${inputValue}`);
          },
          screenshot: {
            name: "frame-4",
            requireText: ["Organization server", `Current organization server: ${ORG_URL}`, "Save", "Reset"],
            rejectText: ["Developer mode only", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Reset returns to standard OpenWork Cloud and the welcome link state", {
          voiceover: vo[4],
          action: async () => {
            await assertAdvancedOrganizationServerFirst(ctx);
            await ctx.clickText("Reset", { selector: "[data-section] button" });
            await ctx.waitForText("Using standard OpenWork Cloud.", { timeoutMs: 30_000 });
            await ctx.eval(`${writeOnboardingPrefScript(false)}`);
            await ctx.navigateHash("/welcome");
            await ctx.eval("location.reload()");
            await ctx.waitForText("Using OpenWork on-premises?", { timeoutMs: 60_000 });
          },
          assert: async () => {
            await ctx.expectText("Using OpenWork on-premises?");
            await ctx.expectNoText(`Connected to ${ORG_HOST}`);
            const stored = await ctx.eval(`localStorage.getItem("openwork.den.baseUrl")`);
            ctx.assert(stored === DEFAULT_DEN_BASE_URL, `Expected reset control plane URL to be ${DEFAULT_DEN_BASE_URL}, got ${stored}`);
          },
          screenshot: {
            name: "frame-5",
            requireText: ["Using OpenWork on-premises?"],
            rejectText: [`Connected to ${ORG_HOST}`, "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        try {
          await ctx.prove("The forced sign-in gate exposes the same on-premises server option without developer mode", {
            voiceover: vo[5],
            action: async () => {
              await closeDialogs(ctx);
              const current = await currentDenBaseUrls(ctx);
              await setDesktopBootstrapConfig(ctx, {
                baseUrl: current.baseUrl,
                apiBaseUrl: current.apiBaseUrl,
                requireSignin: true,
              });
              await ctx.eval(`(() => {
                location.hash = "#/signin";
                location.reload();
                return true;
              })()`);
              await ctx.waitForText("Sign in with OpenWork Cloud", { timeoutMs: 60_000 });
              await ctx.expectNoText("Developer mode only");
              await ctx.expectText("Using OpenWork on-premises?");
              await ctx.clickText("Using OpenWork on-premises?");
              await ctx.expectText("Connect to your organization's server");
              await ctx.expectText("Paste the server URL your IT team shared.");
              await ctx.fill('input[placeholder="https://openwork.yourcompany.com"]', ORG_URL);
              await ctx.clickText("Save", { selector: '[role="dialog"] button' });
              await ctx.waitForText(`Connected to ${ORG_HOST}`, { timeoutMs: 30_000 });
              // The dialog closes with a fade animation; screenshotting while the
              // ghost overlay is still fading produced a dirty frame. Wait for the
              // dialog (and any [role="dialog"] remnant) to be fully unmounted.
              await ctx.waitFor(
                "!document.querySelector('[role=\\\"dialog\\\"]') && !(document.body?.innerText ?? '').includes('Connect to your organization')",
                { timeoutMs: 10_000, label: "organization server dialog fully closed" },
              );
            },
            assert: async () => {
              await ctx.expectText(`Connected to ${ORG_HOST}`);
              await ctx.expectText("Change");
              await ctx.expectNoText("Developer mode only");
              const stored = await ctx.eval(`localStorage.getItem("openwork.den.baseUrl")`);
              ctx.assert(stored === ORG_URL, `Expected forced sign-in control plane URL to be ${ORG_URL}, got ${stored}`);
              const bootstrap = await ctx.eval(`(async () => {
                const config = await window.__OPENWORK_ELECTRON__.invokeDesktop("getDesktopBootstrapConfig");
                return { baseUrl: config.baseUrl, requireSignin: config.requireSignin === true };
              })()`, { awaitPromise: true });
              ctx.assert(bootstrap.requireSignin === true, "Expected forced sign-in to remain enabled while proving the gate.");
              ctx.assert(bootstrap.baseUrl === ORG_URL, `Expected desktop bootstrap URL to be ${ORG_URL}, got ${bootstrap.baseUrl}`);
            },
            screenshot: {
              name: "frame-6",
              requireText: [`Connected to ${ORG_HOST}`, "Change"],
              rejectText: ["Developer mode only", "Something went wrong"],
            },
          });
        } finally {
          await resetToDefaultWelcome(ctx);
        }
      },
    },
  ],
};
