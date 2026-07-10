import { readFile } from "node:fs/promises";

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
  waitUntil,
} from "./desktop-brand-icon.flow.mjs";
import {
  daytonaComputerUsePress,
  daytonaComputerUseStart,
  daytonaComputerUseType,
  daytonaComputerUseWindows,
} from "../runner/daytona-computer-use.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/windows-brand-icon-real-taskbar.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("windows-brand-icon-real-taskbar");

function sandboxId(ctx) {
  return (ctx.env.OPENWORK_EVAL_DAYTONA_SANDBOX_ID || ctx.env.OPENWORK_EVAL_DAYTONA_SANDBOX).trim();
}

function testIconUrl(ctx) {
  return ctx.env.OPENWORK_EVAL_BRAND_ICON_URL.trim();
}

async function getBrandIconState(ctx) {
  return ctx.eval("window.__OPENWORK_ELECTRON__?.brandIcon?.getState?.()", { awaitPromise: true });
}

async function closeAdminPanel(ctx) {
  await ctx.eval(`(async () => {
    await window.__OPENWORK_ELECTRON__?.browser?.closeAllTabs?.();
    await window.__OPENWORK_ELECTRON__?.browser?.hide?.();
    return true;
  })()`, { awaitPromise: true });
  await ensureWorkspaceReady(ctx);
  await ctx.waitForText("Search sessions", { timeoutMs: 30_000 });
}

async function windowsExec(ctx, label, command) {
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const toolboxBase = (ctx.env.DAYTONA_TOOLBOX_URL || "https://proxy.app.daytona.io/toolbox").replace(/\/$/, "");
  const response = await fetch(`${toolboxBase}/${encodeURIComponent(sandboxId(ctx))}/process/execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.env.DAYTONA_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command: `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      timeout: 60,
    }),
    signal: AbortSignal.timeout(70_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.exitCode !== 0) {
    throw new Error(`Daytona Windows ${label} failed (${response.status}/${payload.exitCode ?? "unknown"}): ${payload.result ?? ""}`.trim());
  }
  const stdout = typeof payload.result === "string" ? payload.result : "";
  ctx.log(`Daytona Windows ${label}: ${stdout.trim().slice(0, 500)}`);
  return { stdout };
}

async function assertWindowsBrandShortcut(ctx, expected) {
  const result = await windowsExec(ctx, "check organization shortcut", `
$path = 'C:\\Users\\Administrator\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\OpenWork Organization.lnk'
if (Test-Path -LiteralPath $path) { Write-Output 'present' } else { Write-Output 'absent' }
`);
  const actual = result.stdout.match(/(?:^|\r?\n)(present|absent)(?:\r?\n|$)/)?.[1] ?? result.stdout.trim();
  ctx.assert(actual === expected, `Expected branded Start Menu shortcut to be ${expected}, got ${actual}`);
  ctx.recordEvidence({
    type: "assertion",
    status: "passed",
    assertion: expected === "present"
      ? "The per-user branded Start Menu shortcut exists"
      : "The per-user branded Start Menu shortcut was removed",
    actual,
  });
}

async function installAltTabHarness(ctx) {
  const source = await readFile(new URL("../support/windows-hold-alt-tab.ps1", import.meta.url), "utf8");
  const payload = Buffer.from(source, "utf8").toString("base64");
  await windowsExec(ctx, "install Alt-Tab harness", `
$directory = 'C:\\ow'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
[IO.File]::WriteAllBytes('C:\\ow\\windows-hold-alt-tab.ps1', [Convert]::FromBase64String('${payload}'))
Write-Output 'C:\\ow\\windows-hold-alt-tab.ps1'
`);
}

async function showAltTabSwitcher(ctx) {
  const sandbox = sandboxId(ctx);
  // The key endpoint works across both the current Computer Use plugin and
  // older Windows snapshots whose hotkey parser does not normalize win/cmd.
  await daytonaComputerUsePress(sandbox, "r", ["cmd"]);
  await sleep(300);
  await daytonaComputerUseType(
    sandbox,
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\ow\\windows-hold-alt-tab.ps1",
  );
  await daytonaComputerUsePress(sandbox, "enter");
  await sleep(1_200);
}

async function assertOpenWorkWindow(ctx) {
  const result = await daytonaComputerUseWindows(sandboxId(ctx));
  const windows = Array.isArray(result?.windows) ? result.windows : [];
  const openwork = windows.find((entry) => /openwork/i.test(entry?.title ?? ""));
  ctx.assert(Boolean(openwork), `Daytona Computer Use did not find an OpenWork window: ${JSON.stringify(windows)}`);
  ctx.recordEvidence({
    type: "assertion",
    status: "passed",
    assertion: "Daytona Computer Use sees the real OpenWork window in the interactive Windows session",
    actual: openwork?.title,
  });
}

async function assertWindowsRuntime(ctx) {
  const info = await ctx.eval("window.__OPENWORK_ELECTRON__?.system?.getArchitectureInfo?.()", { awaitPromise: true });
  ctx.assert(info?.platform === "windows", `Expected a Windows Electron build, got ${JSON.stringify(info)}`);
  ctx.recordEvidence({
    type: "assertion",
    status: "passed",
    assertion: "Electron reports the real Windows runtime",
    actual: JSON.stringify({ platform: info.platform, appArch: info.appArch, version: info.version }),
  });
}

function computerUseScreenshot(name, options = {}) {
  return {
    name,
    sandboxCapture: "computer-use",
    ...options,
  };
}

export default {
  id: "windows-brand-icon-real-taskbar",
  title: "Organization icon updates the real Windows taskbar live, at boot, and on clear",
  kind: "user-facing",
  spec: "evals/voiceovers/windows-brand-icon-real-taskbar.md",
  preserveTheme: true,
  requiredEnv: [
    "DAYTONA_API_KEY",
    "OPENWORK_EVAL_BRAND_ICON_URL",
    "OPENWORK_EVAL_DAYTONA_SANDBOX",
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
    "OPENWORK_EVAL_DEN_WEB_URL",
  ],
  steps: [
    {
      name: "setup",
      run: async (ctx) => {
        await daytonaComputerUseStart(sandboxId(ctx));
        await ensureRendererMounted(ctx);
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 30_000,
          label: "window.__openworkControl",
        });
        await assertWindowsRuntime(ctx);
        await assertSignedIntoDen(ctx);
        await waitUntil(ctx, "desktop Den auth provider signed in", async () => {
          const status = await ctx.control("auth.status", {}).catch(() => null);
          return status?.status !== "checking" && status?.user ? status : null;
        }, { timeoutMs: 30_000 });
        await ensureWorkspaceReady(ctx);
        await denFetch(ctx, "/v1/org", {
          method: "PATCH",
          body: JSON.stringify({ brandIconUrl: null }),
        });
        await memberRefresh(ctx);
        await waitForDesktopConfig(ctx, "server brandIconUrl reset", (config) => !config.brandIconUrl);
        await waitForBrandIconState(ctx, "stock icon active during setup", (state) =>
          state?.applied === false && state?.reason === null,
        30_000, { refresh: true });
        await installAltTabHarness(ctx);
        await closeAdminPanel(ctx);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The stock OpenWork icon is visible in the real Windows taskbar", {
          voiceover: vo[0],
          action: async () => {
            await assertOpenWorkWindow(ctx);
          },
          assert: async () => {
            const state = await getBrandIconState(ctx);
            ctx.assert(state?.applied === false && state?.reason === null, `Expected stock icon state, got ${JSON.stringify(state)}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Native icon state is stock with no apply failure", actual: JSON.stringify(state) });
          },
          screenshot: computerUseScreenshot("stock-icon-real-taskbar", { requireText: ["Search sessions"] }),
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The organization owner saves a Den-served square icon", {
          voiceover: vo[1],
          action: async () => {
            await openAdminPanel(ctx);
            await adminEnsureFreshAuth(ctx);
            await navigateAdminOrgSettings(ctx);
            await setIconUrlInPanel(ctx, testIconUrl(ctx));
            await sleep(300);
            await clickSaveSettings(ctx);
          },
          assert: async () => {
            const config = await waitForDesktopConfig(ctx, "server brandIconUrl to match the Den-served icon", (body) =>
              body.brandIconUrl === testIconUrl(ctx),
            );
            ctx.assert(config.brandIconUrl === testIconUrl(ctx), `Expected brandIconUrl=${testIconUrl(ctx)}, got ${config.brandIconUrl}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Den API returns the saved on-prem icon URL", actual: config.brandIconUrl });
            const iconFieldVisible = await panelEval(ctx, `(() => {
              const input = [...document.querySelectorAll('input')].find((entry) => entry.value === ${JSON.stringify(testIconUrl(ctx))});
              input?.scrollIntoView({ block: 'center' });
              return Boolean(input);
            })()`);
            ctx.assert(iconFieldVisible, "The saved icon field was not available for visible Windows proof.");
            await sleep(300);
          },
          screenshot: computerUseScreenshot("owner-saves-company-icon", {
            textTargetUrlIncludes: ORG_SETTINGS_PATH,
            requireText: ["Brand Appearance", "Icon URL"],
          }),
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The live Windows taskbar and Alt-Tab identity use the organization icon", {
          voiceover: vo[2],
          action: async () => {
            await memberRefresh(ctx);
            await waitForBrandIconState(ctx, "Windows taskbar icon applied", (state) =>
              state?.applied === true && state?.sourceUrl === testIconUrl(ctx) && state?.reason === null,
            30_000, { refresh: true });
            await closeAdminPanel(ctx);
            await showAltTabSwitcher(ctx);
          },
          assert: async () => {
            const state = await getBrandIconState(ctx);
            ctx.assert(
              state?.applied === true && state?.sourceUrl === testIconUrl(ctx) && state?.reason === null,
              `Expected successful Windows icon state, got ${JSON.stringify(state)}`,
            );
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Windows setIcon and setAppDetails both completed for the Den-served icon", actual: JSON.stringify(state) });
            await assertWindowsBrandShortcut(ctx, "present");
            await assertOpenWorkWindow(ctx);
          },
          screenshot: computerUseScreenshot("company-icon-taskbar-and-alt-tab", { requireText: ["Search sessions"] }),
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        let bootState = null;
        await ctx.prove("Relaunch applies the cached organization icon before the first visible window", {
          voiceover: vo[3],
          action: async () => {
            // Wait for the Alt-Tab harness to release Alt before relaunching.
            await sleep(8_000);
            const hasEvalRelaunch = await ctx.eval(
              "window.__openworkControl.listActions().some((action) => action.id === 'eval.app.relaunch' && !action.disabled)",
            );
            try {
              if (hasEvalRelaunch) {
                await ctx.control("eval.app.relaunch", {});
              } else {
                // Release packages intentionally omit the dev-only control
                // action. Exercise the production relaunch bridge instead.
                await ctx.eval("window.__OPENWORK_ELECTRON__.shell.relaunch()", { awaitPromise: true });
              }
            } catch (error) {
              ctx.log(`Relaunch ended during the expected process shutdown: ${error instanceof Error ? error.message : String(error)}`);
            }
            // Do not reconnect to the outgoing process while it is shutting down.
            await sleep(1_000);
            await ctx.reconnect({ timeoutMs: 120_000 });
            await ensureRendererMounted(ctx);
            bootState = await waitForBrandIconState(ctx, "cached Windows taskbar icon after relaunch", (state) =>
              state?.applied === true && state?.sourceUrl === testIconUrl(ctx) && state?.reason === null,
            30_000);
            await ctx.waitForText("Search sessions", { timeoutMs: 30_000 });
            await sleep(3_000);
          },
          assert: async () => {
            ctx.assert(bootState?.applied === true && bootState?.reason === null, `Expected cached icon at boot, got ${JSON.stringify(bootState)}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "The first relaunched BrowserWindow applied the cached Windows taskbar identity", actual: JSON.stringify(bootState) });
            await assertOpenWorkWindow(ctx);
          },
          screenshot: computerUseScreenshot("company-icon-first-window-after-relaunch", { requireText: ["Search sessions"] }),
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Clearing organization branding restores the stock Windows icon", {
          voiceover: vo[4],
          action: async () => {
            await openAdminPanel(ctx);
            await adminEnsureFreshAuth(ctx);
            await navigateAdminOrgSettings(ctx);
            await setIconUrlInPanel(ctx, "");
            await sleep(300);
            await clickSaveSettings(ctx);
            await waitForDesktopConfig(ctx, "server brandIconUrl cleared", (body) => !body.brandIconUrl);
            await memberRefresh(ctx);
            await waitForBrandIconState(ctx, "stock Windows taskbar icon restored", (state) =>
              state?.applied === false && state?.sourceUrl === null && state?.reason === null,
            30_000, { refresh: true });
            await closeAdminPanel(ctx);
            await sleep(2_000);
          },
          assert: async () => {
            const state = await getBrandIconState(ctx);
            ctx.assert(
              state?.applied === false && state?.sourceUrl === null && state?.reason === null,
              `Expected restored stock icon, got ${JSON.stringify(state)}`,
            );
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Windows taskbar identity returned to the executable's stock icon", actual: JSON.stringify(state) });
            await assertWindowsBrandShortcut(ctx, "absent");
            await assertOpenWorkWindow(ctx);
          },
          screenshot: computerUseScreenshot("stock-icon-restored", { requireText: ["Search sessions"] }),
        });
      },
    },
  ],
};
