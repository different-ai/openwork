import {
  daytonaComputerUsePress,
  daytonaComputerUseStart,
  daytonaComputerUseType,
  daytonaComputerUseWindows,
} from "../runner/daytona-computer-use.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "desktop-upgrade-preserves-server-url";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const ORG_URL = "http://openwork.example-manufacturing.internal:48765";
const HOSTED_URL = "https://app.openworklabs.com";
const CANONICAL_BOOTSTRAP = "C:\\Users\\Administrator\\AppData\\Local\\openwork\\desktop-bootstrap.json";
const LEGACY_BOOTSTRAP = "C:\\Users\\Administrator\\.config\\openwork\\desktop-bootstrap.json";
const DOWNLOAD_BUNDLE = "C:\\Users\\Administrator\\Downloads\\Example Manufacturing Upgrade";
const INSTALLED_DESKTOP_DIR = "C:\\Users\\Administrator\\AppData\\Local\\Programs\\@openworkdesktop";
const BRANCH_LAUNCHER = "C:\\ow\\desktop-upgrade-url\\launch-openwork.cmd";
const FIREWALL_RULE = "OpenWork Upgrade URL Airgap Eval";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sandboxId(ctx) {
  return (ctx.env.OPENWORK_EVAL_DAYTONA_SANDBOX_ID || ctx.env.OPENWORK_EVAL_DAYTONA_SANDBOX).trim();
}

function windowsAppPath(ctx) {
  return ctx.env.OPENWORK_EVAL_WINDOWS_APP_PATH.trim();
}

function windowsInstallerPath(ctx) {
  return ctx.env.OPENWORK_EVAL_WINDOWS_INSTALLER_PATH.trim();
}

function standardInstallerPath(ctx) {
  return ctx.env.OPENWORK_EVAL_WINDOWS_STANDARD_INSTALLER_PATH.trim();
}

function computerUseScreenshot(name, options = {}) {
  return {
    name,
    sandboxCapture: "computer-use",
    ...options,
  };
}

async function windowsExec(ctx, label, command, timeout = 60) {
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
      timeout,
    }),
    signal: AbortSignal.timeout((timeout + 10) * 1_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.exitCode !== 0) {
    throw new Error(`Daytona Windows ${label} failed (${response.status}/${payload.exitCode ?? "unknown"}): ${payload.result ?? ""}`.trim());
  }
  const stdout = typeof payload.result === "string" ? payload.result : "";
  ctx.log(`Daytona Windows ${label}: ${stdout.trim().slice(0, 700)}`);
  return stdout;
}

function parseJsonOutput(output) {
  const start = output.indexOf("{");
  if (start < 0) throw new Error(`Windows output did not contain JSON: ${output}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const char = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(output.slice(start, index + 1));
    }
  }
  throw new Error(`Windows output contained incomplete JSON: ${output}`);
}

async function readCanonicalBootstrap(ctx) {
  const output = await windowsExec(ctx, "read canonical bootstrap", `
$path = '${CANONICAL_BOOTSTRAP}'
if (-not (Test-Path -LiteralPath $path)) { throw "Missing canonical bootstrap: $path" }
Get-Content -LiteralPath $path -Raw
`);
  return parseJsonOutput(output);
}

async function assertOrganizationBootstrap(ctx, label) {
  const config = await readCanonicalBootstrap(ctx);
  ctx.assert(config.baseUrl === ORG_URL, `${label}: expected ${ORG_URL}, got ${config.baseUrl}`);
  ctx.assert(config.baseUrl !== HOSTED_URL, `${label}: hosted default replaced the organization URL`);
  ctx.recordEvidence({
    type: "assertion",
    status: "passed",
    assertion: `${label}: canonical desktop-bootstrap.json retains the Example Manufacturing on-prem URL`,
    actual: JSON.stringify({ baseUrl: config.baseUrl, apiBaseUrl: config.apiBaseUrl, writtenAt: config.writtenAt }),
  });
  ctx.output(`${label} desktop-bootstrap.json`, JSON.stringify(config, null, 2));
  return config;
}

async function stopOpenWork(ctx) {
  await windowsExec(ctx, "stop OpenWork", `
Get-Process -Name OpenWork -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800
Write-Output 'OpenWork stopped'
`);
}

async function launchViaRun(ctx, command) {
  await daytonaComputerUsePress(sandboxId(ctx), "escape");
  await daytonaComputerUsePress(sandboxId(ctx), "r", ["cmd"]);
  await sleep(400);
  await daytonaComputerUseType(sandboxId(ctx), command);
  await daytonaComputerUsePress(sandboxId(ctx), "enter");
}

async function launchBranchApp(ctx) {
  const launcher = `@echo off\r\nset "XDG_CONFIG_HOME="\r\nset "LOCALAPPDATA=C:\\Users\\Administrator\\AppData\\Local"\r\nset "OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=9825"\r\nstart "" "${windowsAppPath(ctx)}"\r\n`;
  const launcherBase64 = Buffer.from(launcher, "utf8").toString("base64");
  await windowsExec(ctx, "write branch app launcher", `
[IO.File]::WriteAllBytes('${BRANCH_LAUNCHER}', [Convert]::FromBase64String('${launcherBase64}'))
Write-Output 'branch app launcher ready'
`);
  await launchViaRun(ctx, BRANCH_LAUNCHER);
  await sleep(1_000);
  await ctx.reconnect({ timeoutMs: 120_000 });
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__)", {
    timeoutMs: 60_000,
    label: "Windows Electron bridge",
  });
}

async function waitForWindow(ctx, pattern, expected, timeoutMs = 30_000) {
  const startedAt = Date.now();
  let lastTitles = [];
  while (Date.now() - startedAt < timeoutMs) {
    const result = await daytonaComputerUseWindows(sandboxId(ctx));
    lastTitles = Array.isArray(result?.windows) ? result.windows.map((entry) => entry?.title ?? "") : [];
    const present = lastTitles.some((title) => pattern.test(title));
    if (present === expected) return lastTitles;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for Windows title ${pattern} present=${expected}: ${JSON.stringify(lastTitles)}`);
}

async function showAdvancedServer(ctx) {
  await ctx.navigateHash("/settings/advanced");
  await ctx.waitForText("Organization server", { timeoutMs: 60_000 });
  await ctx.waitForText(ORG_URL, { timeoutMs: 60_000 });
  await ctx.eval(`(() => {
    const nodes = [...document.querySelectorAll("div,section")];
    const target = nodes.find((node) => node.children.length < 8 && (node.textContent ?? "").includes("Server endpoints"));
    target?.scrollIntoView({ block: "center" });
    return Boolean(target);
  })()`);
  await sleep(500);
}

async function showBootstrapDebug(ctx) {
  await ctx.eval(`localStorage.setItem("openwork.developerMode", "1")`);
  await ctx.navigateHash("/settings/debug");
  await ctx.waitForText("Bootstrap config", { timeoutMs: 60_000 });
  await ctx.waitForText(ORG_URL, { timeoutMs: 60_000 });
  await ctx.eval(`(() => {
    const nodes = [...document.querySelectorAll("div,section")];
    const target = nodes.find((node) => node.children.length < 10 && (node.textContent ?? "").includes("Bootstrap config"));
    target?.scrollIntoView({ block: "center" });
    return Boolean(target);
  })()`);
  await sleep(500);
}

async function prepareCanonicalState(ctx) {
  const standardInstaller = standardInstallerPath(ctx).replaceAll("'", "''");
  await windowsExec(ctx, "prepare canonical organization state", `
$canonical = '${CANONICAL_BOOTSTRAP}'
$legacy = '${LEGACY_BOOTSTRAP}'
$bundle = '${DOWNLOAD_BUNDLE}'
Get-Process -Name msedge,openwork-installer -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match '^OpenWork Setup' } | Stop-Process -Force
Remove-Item -LiteralPath 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Sessions' -Recurse -Force -ErrorAction SilentlyContinue
New-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge' -Name HideFirstRunExperience -PropertyType DWord -Value 1 -Force | Out-Null
New-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge' -Name RestoreOnStartup -PropertyType DWord -Value 5 -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $canonical) -Force | Out-Null
New-Item -ItemType Directory -Path $bundle -Force | Out-Null
Remove-Item -LiteralPath $legacy -Force -ErrorAction SilentlyContinue
$organization = [ordered]@{
  baseUrl = '${ORG_URL}'
  apiBaseUrl = '${ORG_URL}'
  requireSignin = $false
  brandAppName = 'Example Manufacturing Work'
  writtenAt = '2026-07-09T12:00:00.000Z'
}
$hosted = [ordered]@{
  baseUrl = '${HOSTED_URL}'
  apiBaseUrl = 'https://api.openworklabs.com'
  requireSignin = $true
  brandAppName = 'OpenWork'
  writtenAt = '2026-07-10T12:00:00.000Z'
}
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($canonical, ($organization | ConvertTo-Json), $utf8NoBom)
[IO.File]::WriteAllText((Join-Path $bundle 'desktop-bootstrap.json'), ($hosted | ConvertTo-Json), $utf8NoBom)
Copy-Item -LiteralPath '${standardInstaller}' -Destination (Join-Path $bundle 'openwork-win-x64-0.17.20.exe') -Force
Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue
Write-Output 'canonical organization state ready'
`);
}

async function prepareLegacyUpgradeState(ctx) {
  await windowsExec(ctx, "prepare legacy organization state", `
$canonical = '${CANONICAL_BOOTSTRAP}'
$legacy = '${LEGACY_BOOTSTRAP}'
New-Item -ItemType Directory -Path (Split-Path -Parent $legacy) -Force | Out-Null
$organization = [ordered]@{
  baseUrl = '${ORG_URL}'
  apiBaseUrl = '${ORG_URL}'
  requireSignin = $false
  brandAppName = 'Example Manufacturing Work'
  writtenAt = '2026-07-09T12:00:00.000Z'
}
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($legacy, ($organization | ConvertTo-Json), $utf8NoBom)
Remove-Item -LiteralPath $canonical -Force -ErrorAction SilentlyContinue
Write-Output 'legacy organization state ready beside newer hosted download bundle'
`);
}

export default {
  id: FLOW_ID,
  title: "Windows upgrades preserve organization bootstrap URLs across canonical, legacy, restart, and air-gapped paths",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: [
    "DAYTONA_API_KEY",
    "OPENWORK_EVAL_DAYTONA_SANDBOX",
    "OPENWORK_EVAL_WINDOWS_APP_PATH",
    "OPENWORK_EVAL_WINDOWS_INSTALLER_PATH",
    "OPENWORK_EVAL_WINDOWS_STANDARD_INSTALLER_PATH",
  ],
  steps: [
    {
      name: "Setup isolated Windows organization state",
      run: async (ctx) => {
        await daytonaComputerUseStart(sandboxId(ctx));
        await stopOpenWork(ctx);
        await prepareCanonicalState(ctx);
        await launchBranchApp(ctx);
      },
    },
    {
      name: "Frame 1 — existing organization bootstrap",
      run: async (ctx) => {
        await ctx.prove("The installed Windows desktop is configured for Example Manufacturing", {
          voiceover: vo[0],
          action: async () => {
            await showAdvancedServer(ctx);
          },
          assert: async () => {
            const runtime = await ctx.eval("window.__OPENWORK_ELECTRON__?.system?.getArchitectureInfo?.()", { awaitPromise: true });
            ctx.assert(runtime?.platform === "windows", `Expected Windows Electron, got ${JSON.stringify(runtime)}`);
            await ctx.expectText("From bootstrap file");
            await ctx.expectText(ORG_URL);
            await assertOrganizationBootstrap(ctx, "before upgrade");
          },
          screenshot: computerUseScreenshot("existing-organization-bootstrap", {
            requireText: ["Organization server", "From bootstrap file", ORG_URL],
          }),
        });
      },
    },
    {
      name: "Frame 2 — upgrade installer runs",
      run: async (ctx) => {
        let installerTitles = [];
        await ctx.prove("The Windows installer upgrades an existing organization-configured desktop", {
          voiceover: vo[1],
          action: async () => {
            await stopOpenWork(ctx);
            await windowsExec(ctx, "remove prior installed desktop binaries", `
Remove-Item -LiteralPath '${INSTALLED_DESKTOP_DIR}' -Recurse -Force -ErrorAction SilentlyContinue
Write-Output 'prior desktop binaries removed; bootstrap retained'
            `);
            await windowsExec(ctx, "exercise organization bootstrap migration", `
$env:LOCALAPPDATA = 'C:\\Users\\Administrator\\AppData\\Local'
$env:USERPROFILE = 'C:\\Users\\Administrator'
& '${windowsInstallerPath(ctx)}' --headless --dry-run
if ($LASTEXITCODE -ne 0) { throw "Organization installer dry run failed with exit code $LASTEXITCODE" }
`);
            await launchViaRun(ctx, standardInstallerPath(ctx));
            installerTitles = await waitForWindow(ctx, /OpenWork Setup/i, true, 30_000);
            await sleep(500);
          },
          assert: async () => {
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "The real Windows desktop upgrade installer is visibly running", actual: JSON.stringify(installerTitles.filter(Boolean)) });
            await assertOrganizationBootstrap(ctx, "while installer is running");
          },
          screenshot: computerUseScreenshot("windows-upgrade-installer-progress"),
        });
      },
    },
    {
      name: "Frame 3 — upgraded app reuses organization URL",
      run: async (ctx) => {
        await ctx.prove("The upgraded branch desktop reuses the installed organization URL", {
          voiceover: vo[2],
          action: async () => {
            const startedAt = Date.now();
            let installedReady = false;
            while (Date.now() - startedAt < 180_000) {
              const installed = await windowsExec(ctx, "check installed desktop", `
if (Test-Path -LiteralPath '${INSTALLED_DESKTOP_DIR}\\OpenWork.exe') { Write-Output 'installed' } else { Write-Output 'missing' }
`);
              if (installed.includes("installed")) {
                installedReady = true;
                break;
              }
              await sleep(2_000);
            }
            ctx.assert(installedReady, "The Windows installer did not restore the packaged desktop within 180 seconds.");
            await sleep(5_000);
            await stopOpenWork(ctx);
            await launchBranchApp(ctx);
            await showAdvancedServer(ctx);
          },
          assert: async () => {
            await ctx.expectText("From bootstrap file");
            await ctx.expectText(ORG_URL);
            await ctx.expectNoText(HOSTED_URL);
            await assertOrganizationBootstrap(ctx, "after upgrade launch");
          },
          screenshot: computerUseScreenshot("upgraded-app-reuses-organization-url", {
            requireText: ["Server endpoints", "From bootstrap file", ORG_URL],
            rejectText: [HOSTED_URL],
          }),
        });
      },
    },
    {
      name: "Frame 4 — full app restart persists organization URL",
      run: async (ctx) => {
        await ctx.prove("A full app relaunch keeps the organization bootstrap", {
          voiceover: vo[3],
          action: async () => {
            try {
              await ctx.eval("window.__OPENWORK_ELECTRON__.shell.relaunch()", { awaitPromise: true });
            } catch (error) {
              ctx.log(`Expected relaunch disconnect: ${error instanceof Error ? error.message : String(error)}`);
            }
            await sleep(1_000);
            await ctx.reconnect({ timeoutMs: 120_000 });
            await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__)", { timeoutMs: 60_000, label: "Electron bridge after restart" });
            await showBootstrapDebug(ctx);
          },
          assert: async () => {
            await ctx.expectText("Bootstrap config");
            await ctx.expectText(ORG_URL);
            await assertOrganizationBootstrap(ctx, "after full restart");
          },
          screenshot: computerUseScreenshot("organization-url-after-full-restart", {
            requireText: ["Bootstrap config", ORG_URL],
          }),
        });
      },
    },
    {
      name: "Frame 5 — legacy update path preserves organization URL",
      run: async (ctx) => {
        await ctx.prove("The legacy Windows bootstrap path outranks a newer hosted download bundle", {
          voiceover: vo[4],
          action: async () => {
            await stopOpenWork(ctx);
            await prepareLegacyUpgradeState(ctx);
            await launchBranchApp(ctx);
            await showAdvancedServer(ctx);
          },
          assert: async () => {
            await ctx.expectText("From bootstrap file");
            await ctx.expectText(ORG_URL);
            await ctx.expectNoText(HOSTED_URL);
            await assertOrganizationBootstrap(ctx, "after legacy-path upgrade");
          },
          screenshot: computerUseScreenshot("legacy-upgrade-path-keeps-organization-url", {
            requireText: ["Organization server", "From bootstrap file", ORG_URL],
            rejectText: [HOSTED_URL],
          }),
        });
      },
    },
    {
      name: "Frame 6 — air-gapped restart keeps organization URL",
      run: async (ctx) => {
        await ctx.prove("An offline Windows restart keeps the organization bootstrap without cloud replacement", {
          voiceover: vo[5],
          action: async () => {
            await stopOpenWork(ctx);
            const appPath = windowsAppPath(ctx).replaceAll("'", "''");
            await windowsExec(ctx, "block desktop outbound network", `
Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -Direction Outbound -Program '${appPath}' -Action Block -Profile Any | Out-Null
Write-Output 'outbound network blocked for branch desktop'
`);
            await launchBranchApp(ctx);
            await showBootstrapDebug(ctx);
          },
          assert: async () => {
            const firewall = await windowsExec(ctx, "verify outbound firewall rule", `
$rule = Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction Stop
Write-Output $rule.Enabled
Write-Output $rule.Action
`);
            ctx.assert(firewall.includes("True") && firewall.includes("Block"), `Expected active outbound block rule, got ${firewall}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Windows Firewall blocks outbound traffic for the tested OpenWork executable", actual: firewall.trim() });
            await ctx.expectText("Bootstrap config");
            await ctx.expectText(ORG_URL);
            await assertOrganizationBootstrap(ctx, "during air-gapped restart");
          },
          screenshot: computerUseScreenshot("air-gapped-restart-keeps-organization-url", {
            requireText: ["Bootstrap config", ORG_URL],
          }),
        });
      },
    },
    {
      name: "Cleanup Windows firewall rule",
      run: async (ctx) => {
        await windowsExec(ctx, "remove eval firewall rule", `
Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue
Write-Output 'eval firewall rule removed'
`);
      },
    },
  ],
};
