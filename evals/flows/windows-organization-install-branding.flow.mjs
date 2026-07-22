import {
  daytonaComputerUsePress,
  daytonaComputerUseStart,
  daytonaComputerUseType,
} from "../runner/daytona-computer-use.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("windows-organization-install-branding");
const BUNDLE_DIR = "C:\\Users\\Administrator\\Downloads\\Northwind";
const INSTALLER = `${BUNDLE_DIR}\\openwork-win-x64-0.17.20.exe`;
const START_MENU = "C:\\Users\\Administrator\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs";
const CONFIG = "C:\\Users\\Administrator\\AppData\\Local\\openwork\\desktop-bootstrap.json";

function sandboxId(ctx) {
  return (ctx.env.OPENWORK_EVAL_DAYTONA_SANDBOX_ID || ctx.env.OPENWORK_EVAL_DAYTONA_SANDBOX).trim();
}

async function windowsExec(ctx, label, command, timeout = 120) {
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const toolbox = (ctx.env.DAYTONA_TOOLBOX_URL || "https://proxy.app.daytona.io/toolbox").replace(/\/$/, "");
  const response = await fetch(`${toolbox}/${encodeURIComponent(sandboxId(ctx))}/process/execute`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.env.DAYTONA_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ command: `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, timeout }),
    signal: AbortSignal.timeout((timeout + 15) * 1_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.exitCode !== 0) {
    throw new Error(`${label} failed (${response.status}/${payload.exitCode ?? "unknown"}): ${payload.result ?? ""}`);
  }
  return typeof payload.result === "string" ? payload.result : "";
}

async function openRunCommand(ctx, command) {
  await daytonaComputerUsePress(sandboxId(ctx), "r", ["cmd"]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await daytonaComputerUseType(sandboxId(ctx), command);
  await daytonaComputerUsePress(sandboxId(ctx), "enter");
}

async function launchInstalledApp(ctx) {
  await windowsExec(ctx, "stop previous app", `
Get-Process OpenWork -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
exit 0
`);
  await daytonaComputerUsePress(sandboxId(ctx), "cmd");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await daytonaComputerUseType(sandboxId(ctx), "OpenWork");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await daytonaComputerUsePress(sandboxId(ctx), "enter");
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}

export default {
  id: "windows-organization-install-branding",
  title: "Organization installs converge Windows Search, Start Menu, and shortcuts without losing server configuration",
  kind: "user-facing",
  requiresApp: false,
  requiredEnv: ["DAYTONA_API_KEY", "OPENWORK_EVAL_DAYTONA_SANDBOX"],
  steps: [
    {
      name: "Organization bundle",
      run: async (ctx) => {
        await ctx.prove("The Windows organization bundle keeps the standard installer beside its setup file", {
          voiceover: vo[0],
          action: async () => {
            await daytonaComputerUseStart(sandboxId(ctx));
            await openRunCommand(ctx, `explorer.exe ${BUNDLE_DIR}`);
            await new Promise((resolve) => setTimeout(resolve, 1_500));
          },
          assert: async () => {
            const result = await windowsExec(ctx, "inspect organization bundle", `
[pscustomobject]@{
  Installer = Test-Path '${INSTALLER}'
  Bootstrap = Test-Path '${BUNDLE_DIR}\\desktop-bootstrap.json'
} | ConvertTo-Json
`);
            ctx.assert(result.includes('"Installer":  true') && result.includes('"Bootstrap":  true'), result);
          },
          screenshot: { name: "organization-windows-bundle", sandboxCapture: "computer-use" },
        });
      },
    },
    {
      name: "First launch branding",
      run: async (ctx) => {
        await ctx.prove("First launch imports the organization bootstrap before showing the branded window", {
          voiceover: vo[1],
          action: async () => {
            await windowsExec(ctx, "install Northwind", `
$cmd = 'C:\\ow\\install-northwind-proof.cmd'
[IO.File]::WriteAllLines($cmd, @('@echo off', '${INSTALLER} /S'))
schtasks /create /tn OWBrandProofInstall /tr $cmd /sc once /st 00:00 /ru Administrator /it /rl HIGHEST /f | Out-Null
schtasks /run /tn OWBrandProofInstall | Out-Null
for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
  Start-Sleep -Seconds 2
  $task = schtasks /query /tn OWBrandProofInstall /fo list /v | Out-String
  if ($task -notmatch 'Status:\s+Running') { break }
}
Start-Sleep -Seconds 5
`);
            await launchInstalledApp(ctx);
          },
          assert: async () => {
            const result = await windowsExec(ctx, "inspect first launch", `
$config = Get-Content '${CONFIG}' -Raw | ConvertFrom-Json
[pscustomobject]@{
  AppName = $config.brandAppName
  BaseUrl = $config.baseUrl
  Shortcut = Test-Path '${START_MENU}\\Northwind.lnk'
  StaleShortcut = Test-Path '${START_MENU}\\OpenWork.lnk'
} | ConvertTo-Json
`);
            ctx.assert(result.includes('"AppName":  "Northwind"'), result);
            ctx.assert(result.includes('"BaseUrl":  "https://onprem.northwind.test"'), result);
            ctx.assert(result.includes('"Shortcut":  true') && result.includes('"StaleShortcut":  false'), result);
          },
          screenshot: { name: "northwind-first-window", sandboxCapture: "computer-use" },
        });
      },
    },
    {
      name: "Windows Search identity",
      run: async (ctx) => {
        await ctx.prove("Windows Search exposes only the organization-named shortcut with its organization icon", {
          voiceover: vo[2],
          action: async () => {
            await daytonaComputerUsePress(sandboxId(ctx), "cmd");
            await new Promise((resolve) => setTimeout(resolve, 500));
            await daytonaComputerUseType(sandboxId(ctx), "Northwind");
            await new Promise((resolve) => setTimeout(resolve, 1_500));
          },
          assert: async () => {
            const result = await windowsExec(ctx, "inspect branded shortcut", `
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut('${START_MENU}\\Northwind.lnk')
[pscustomobject]@{ Target = $link.TargetPath; TargetExists = Test-Path $link.TargetPath; Icon = $link.IconLocation } | ConvertTo-Json
`);
            ctx.assert(result.includes('"TargetExists":  true'), result);
            ctx.assert(result.includes("brand-icon.ico"), result);
          },
          screenshot: { name: "northwind-windows-search", sandboxCapture: "computer-use" },
        });
      },
    },
    {
      name: "Upgrade preserves server",
      run: async (ctx) => {
        await ctx.prove("Upgrade recreates branded shortcut metadata while preserving the newer on-prem configuration", {
          voiceover: vo[3],
          action: async () => {
            await windowsExec(ctx, "prepare newer managed config", `
$config = Get-Content '${CONFIG}' -Raw | ConvertFrom-Json
$config.baseUrl = 'https://existing-onprem.northwind.test'
$config.apiBaseUrl = 'https://api.existing-onprem.northwind.test'
$config.writtenAt = (Get-Date).ToUniversalTime().AddMinutes(5).ToString('o')
[IO.File]::WriteAllText('${CONFIG}', ($config | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Remove-Item '${START_MENU}\\Northwind.lnk' -Force
Get-Process OpenWork -ErrorAction SilentlyContinue | Stop-Process -Force
`);
            await launchInstalledApp(ctx);
          },
          assert: async () => {
            const result = await windowsExec(ctx, "inspect upgrade convergence", `
$config = Get-Content '${CONFIG}' -Raw | ConvertFrom-Json
[pscustomobject]@{ BaseUrl = $config.baseUrl; Shortcut = Test-Path '${START_MENU}\\Northwind.lnk'; Stale = Test-Path '${START_MENU}\\OpenWork.lnk' } | ConvertTo-Json
`);
            ctx.assert(result.includes('"BaseUrl":  "https://existing-onprem.northwind.test"'), result);
            ctx.assert(result.includes('"Shortcut":  true') && result.includes('"Stale":  false'), result);
          },
          screenshot: { name: "northwind-after-upgrade", sandboxCapture: "computer-use" },
        });
      },
    },
    {
      name: "Uninstall cleanup",
      run: async (ctx) => {
        await ctx.prove("Uninstall removes the managed organization shortcut without leaving stale OpenWork entries", {
          voiceover: vo[4],
          action: async () => {
            await windowsExec(ctx, "uninstall Northwind", `
Get-Process OpenWork -ErrorAction SilentlyContinue | Stop-Process -Force
$cmd = 'C:\\ow\\uninstall-northwind-proof.cmd'
[IO.File]::WriteAllLines($cmd, @('@echo off', '"C:\\Users\\Administrator\\AppData\\Local\\Programs\\@openworkdesktop\\Uninstall OpenWork.exe" /S'))
schtasks /create /tn OWBrandProofUninstall /tr $cmd /sc once /st 00:00 /ru Administrator /it /rl HIGHEST /f | Out-Null
schtasks /run /tn OWBrandProofUninstall | Out-Null
Start-Sleep -Seconds 15
`);
            await daytonaComputerUsePress(sandboxId(ctx), "cmd");
            await new Promise((resolve) => setTimeout(resolve, 500));
            await daytonaComputerUseType(sandboxId(ctx), "Northwind");
          },
          assert: async () => {
            const result = await windowsExec(ctx, "inspect uninstall cleanup", `
[pscustomobject]@{
  Northwind = Test-Path '${START_MENU}\\Northwind.lnk'
  OpenWork = Test-Path '${START_MENU}\\OpenWork.lnk'
  Marker = Test-Path 'C:\\Users\\Administrator\\AppData\\Roaming\\com.differentai.openwork\\windows-brand-shortcut.txt'
} | ConvertTo-Json
`);
            ctx.assert(result.includes('"Northwind":  false'), result);
            ctx.assert(result.includes('"OpenWork":  false'), result);
            ctx.assert(result.includes('"Marker":  false'), result);
          },
          screenshot: { name: "windows-search-clean-after-uninstall", sandboxCapture: "computer-use" },
        });
      },
    },
  ],
};
