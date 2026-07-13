import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import {
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
  waitForDesktopConfig,
  waitForPanel,
} from "./desktop-brand-icon.flow.mjs";

const vo = await loadVoiceoverParagraphs("organization-display-branding");
const execFileAsync = promisify(execFile);
const APP_NAME = "Acme Work";
const ORG_NAME = "Example Corp";
const ORG_SETTINGS_PATH = "/dashboard/brand-appearance";
const ASSET_PORT = 8091;
const state = {
  logoUrl: null,
  orgId: null,
  installToken: null,
  installPageUrl: null,
  installConfig: null,
  installerUrl: null,
  updaterBefore: null,
};

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function daytonaExec(ctx, label, script, timeout = 90_000) {
  const sandbox = ctx.env.OPENWORK_EVAL_DAYTONA_SANDBOX.trim();
  const encoded = Buffer.from(script, "utf8").toString("base64");
  try {
    const result = await execFileAsync(
      "daytona",
      ["exec", sandbox, "--", "echo", encoded, "|", "base64", "-d", "|", "bash"],
      { timeout, maxBuffer: 2 * 1024 * 1024 },
    );
    ctx.log(`Daytona ${label}: ${result.stdout.trim().slice(0, 500)}`);
    return result.stdout.trim();
  } catch (error) {
    const stdout = error && typeof error === "object" ? error.stdout : "";
    const stderr = error && typeof error === "object" ? error.stderr : "";
    throw new Error(`Daytona ${label} failed: ${errorMessage(error)} stdout=${String(stdout ?? "").slice(0, 500)} stderr=${String(stderr ?? "").slice(0, 500)}`);
  }
}

async function startPrivateWordmark(ctx) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="160" viewBox="0 0 720 160"><rect width="720" height="160" rx="28" fill="#083344"/><circle cx="76" cy="80" r="42" fill="#67e8f9"/><path d="M55 80l17 17 30-36" fill="none" stroke="#083344" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><text x="140" y="101" font-family="Arial,sans-serif" font-size="62" font-weight="700" fill="white">EXAMPLE CORP</text></svg>`;
  const encoded = Buffer.from(svg, "utf8").toString("base64");
  await daytonaExec(ctx, "private wordmark server", `
set -euo pipefail
mkdir -p /tmp/acme-work-assets
printf '%s' '${encoded}' | base64 -d > /tmp/acme-work-assets/wordmark.svg
pkill -f 'http.server ${ASSET_PORT}' 2>/dev/null || true
nohup python3 -m http.server ${ASSET_PORT} --directory /tmp/acme-work-assets >/tmp/acme-work-assets.log 2>&1 </dev/null &
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:${ASSET_PORT}/wordmark.svg >/dev/null && exit 0; sleep 1; done
exit 1
`);
  const preview = await execFileAsync("daytona", ["preview-url", ctx.env.OPENWORK_EVAL_DAYTONA_SANDBOX.trim(), "-p", String(ASSET_PORT)], {
    timeout: 30_000,
  });
  const baseUrl = preview.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("https://"));
  ctx.assert(Boolean(baseUrl), `Daytona did not return an HTTPS preview URL: ${preview.stdout}`);
  return `${baseUrl.replace(/\/$/, "")}/wordmark.svg`;
}

async function setInputByPlaceholder(ctx, placeholder, value) {
  await waitForPanel(ctx, `Boolean(Array.from(document.querySelectorAll('input')).find((input) => input.placeholder === ${JSON.stringify(placeholder)}))`, {
    timeoutMs: 20_000,
    label: `${placeholder} input`,
  });
  return panelEval(ctx, `(() => {
    const input = Array.from(document.querySelectorAll('input')).find((candidate) => candidate.placeholder === ${JSON.stringify(placeholder)});
    if (!input) throw new Error(${JSON.stringify(`${placeholder} input not found`)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('native input value setter not found');
    if (input._valueTracker) input._valueTracker.setValue('__previous__');
    input.focus();
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.scrollIntoView({ block: 'center' });
    return input.value;
  })()`);
}

async function mintInstallLink(ctx) {
  const org = await denFetch(ctx, "/v1/org");
  state.orgId = org.body?.organization?.id ?? null;
  ctx.assert(typeof state.orgId === "string", `Organization response was missing id: ${JSON.stringify(org.body).slice(0, 500)}`);
  await denFetch(ctx, `/v1/admin/organizations/${state.orgId}/capabilities`, {
    method: "PUT",
    body: JSON.stringify({ capabilities: { installLinks: true } }),
  });
  const minted = await denFetch(ctx, `/v1/orgs/${state.orgId}/install-links`, {
    method: "POST",
    body: JSON.stringify({ rotate: false }),
  });
  state.installToken = minted.body?.token ?? null;
  state.installPageUrl = minted.body?.installPageUrl ?? null;
  ctx.assert(typeof state.installToken === "string", `Install-link response was missing token: ${JSON.stringify(minted.body).slice(0, 500)}`);
  ctx.assert(typeof state.installPageUrl === "string", "Install-link response was missing installPageUrl.");
  const config = await fetch(`${ctx.env.OPENWORK_EVAL_DEN_API_URL.replace(/\/$/, "")}/v1/install-config?token=${encodeURIComponent(state.installToken)}`).then(async (response) => {
    const body = await response.json();
    ctx.assert(response.ok, `Install config returned ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
    return body;
  });
  state.installConfig = config;
}

async function startRemoteInstaller(ctx) {
  const binary = ctx.env.OPENWORK_EVAL_INSTALLER_BIN?.trim() || "/workspace/apps/installer/dist/openwork-installer";
  const sidecar = Buffer.from(JSON.stringify(state.installConfig), "utf8").toString("base64");
  const stdout = await daytonaExec(ctx, "configured installer UI", `
set -euo pipefail
work=/tmp/acme-work-installer
rm -rf "$work"
mkdir -p "$work"
cp '${binary}' "$work/openwork-installer"
chmod +x "$work/openwork-installer"
printf '%s' '${sidecar}' | base64 -d > "$work/openwork-installer.json"
pkill -f '/tmp/acme-work-installer/openwork-installer' 2>/dev/null || true
OPENWORK_INSTALLER_UI=manual nohup "$work/openwork-installer" >/tmp/acme-work-installer.log 2>&1 </dev/null &
for _ in $(seq 1 30); do
  url=$(grep -o 'http://127[.]0[.]0[.]1:[0-9]*/' /tmp/acme-work-installer.log | tail -n 1 || true)
  if [ -n "$url" ]; then printf '%s\n' "$url"; exit 0; fi
  sleep 1
done
cat /tmp/acme-work-installer.log >&2
exit 1
`);
  const url = stdout.split(/\r?\n/).find((line) => line.startsWith("http://127.0.0.1:"));
  ctx.assert(Boolean(url), `Installer did not report its UI URL: ${stdout}`);
  state.installerUrl = url;
}

async function nativeWindowTitle(ctx) {
  return daytonaExec(ctx, "native window title", `
set -euo pipefail
export DISPLAY=:99
for candidate in $(xprop -root _NET_CLIENT_LIST 2>/dev/null | grep -o '0x[0-9a-f]*'); do
  title=$(xprop -id "$candidate" WM_NAME 2>/dev/null || true)
  if printf '%s' "$title" | grep -F '${APP_NAME}' >/dev/null; then printf '%s\n' "$title"; exit 0; fi
done
exit 1
`);
}

async function relaunchDesktop(ctx) {
  await daytonaExec(ctx, "quit and relaunch desktop", `
set -euo pipefail
pkill -f '/electron/dist/electron ./electron/main.mjs' 2>/dev/null || true
sleep 3
cd /workspace
OPENWORK_WORKSPACE_DIR=/workspace OPENWORK_DESKTOP_BOOTSTRAP_PATH=/workspace/.openwork-daytona/desktop-bootstrap.json OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=9825 DISPLAY=:99 bash .devcontainer/start-daytona-electron.sh --detach
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:9825/json/list >/dev/null; then printf 'relaunched\n'; exit 0; fi
  sleep 1
done
exit 1
`);
  await ctx.reconnect({ timeoutMs: 120_000 });
  await ensureRendererMounted(ctx);
}

async function signedIdentity(ctx) {
  return daytonaExec(ctx, "signed application identity", `
set -euo pipefail
file=$(find "$HOME/.config" -name openwork-ui-control.json -type f | head -n 1)
test -n "$file"
cat "$file"
`);
}

export default {
  id: "organization-display-branding",
  title: "Organization display branding reaches download, setup, and desktop while OpenWork's signed identity stays stable",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_DAYTONA_SANDBOX",
  ],
  steps: [
    {
      name: "setup",
      run: async (ctx) => {
        await ensureRendererMounted(ctx);
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000, label: "desktop control surface" });
        await ctx.ensureLightMode();
        await assertSignedIntoDen(ctx);
        await ensureWorkspaceReady(ctx);
        state.logoUrl = await startPrivateWordmark(ctx);
        await denFetch(ctx, "/v1/org", {
          method: "PATCH",
          body: JSON.stringify({ name: ORG_NAME, brandAppName: null, brandLogoUrl: null }),
        });
        await memberRefresh(ctx);
        await waitForDesktopConfig(ctx, "display branding baseline", (config) => !config.brandAppName && !config.brandLogoUrl);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("An Example Corp owner saves Acme Work and a wordmark through Brand Appearance", {
          voiceover: vo[0],
          action: async () => {
            await openAdminPanel(ctx);
            await adminEnsureFreshAuth(ctx);
            await navigateAdminOrgSettings(ctx);
            await setInputByPlaceholder(ctx, "OpenWork", APP_NAME);
            await setInputByPlaceholder(ctx, "https://example.com/logo.svg", state.logoUrl);
            await clickSaveSettings(ctx);
          },
          assert: async () => {
            const config = await waitForDesktopConfig(ctx, "Acme Work desktop config", (body) => body.brandAppName === APP_NAME && body.brandLogoUrl === state.logoUrl);
            ctx.assert(config.brandAppName === APP_NAME, `brandAppName was ${config.brandAppName}`);
            ctx.assert(config.brandLogoUrl === state.logoUrl, `brandLogoUrl was ${config.brandLogoUrl}`);
            await panelEval(ctx, `(() => {
              const input = Array.from(document.querySelectorAll('input')).find((candidate) => candidate.placeholder === 'OpenWork');
              input?.scrollIntoView({ block: 'center' });
              return input?.value ?? null;
            })()`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Den desktop config returns the owner-saved app name and private wordmark URL", actual: JSON.stringify({ brandAppName: config.brandAppName, brandLogoUrl: config.brandLogoUrl }) });
          },
          screenshot: { name: "frame-1-owner-saves-acme-work", sandboxCapture: true, textTargetUrlIncludes: ORG_SETTINGS_PATH, requireText: ["Brand appearance", "Application name"] },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Example Corp's Den-hosted install page uses Acme Work and the organization wordmark", {
          voiceover: vo[1],
          action: async () => {
            await mintInstallLink(ctx);
            await panelEval(ctx, `location.replace(${JSON.stringify(state.installPageUrl)})`).catch(() => undefined);
            await waitForPanel(ctx, `document.body.innerText.includes('Download ${APP_NAME} for ${ORG_NAME}')`, { timeoutMs: 45_000, label: "Acme Work install page" });
          },
          assert: async () => {
            ctx.assert(state.installConfig?.appName === APP_NAME, `Install config appName was ${state.installConfig?.appName}`);
            ctx.assert(state.installConfig?.clientName === ORG_NAME, `Install config clientName was ${state.installConfig?.clientName}`);
            ctx.assert(state.installConfig?.logoUrl === state.logoUrl, `Install config logoUrl was ${state.installConfig?.logoUrl}`);
            const logoLoaded = await panelEval(ctx, `(() => { const image = document.querySelector('img[alt="${ORG_NAME} wordmark"]'); return Boolean(image?.complete && image?.naturalWidth > 0); })()`);
            ctx.assert(logoLoaded, "Example Corp wordmark did not load on the install page.");
          },
          screenshot: { name: "frame-2-acme-work-install-page", sandboxCapture: true, textTargetUrlIncludes: "/install?token=", requireText: [`Download ${APP_NAME} for ${ORG_NAME}`], rejectText: [`Team · ${ORG_NAME}`] },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The real configured installer UI identifies Acme Work and Example Corp", {
          voiceover: vo[2],
          action: async () => {
            await startRemoteInstaller(ctx);
            await panelEval(ctx, `location.replace(${JSON.stringify(state.installerUrl)})`).catch(() => undefined);
            await waitForPanel(ctx, `document.body.innerText.includes('${APP_NAME} Installer') && document.body.innerText.includes('${ORG_NAME}')`, { timeoutMs: 30_000, label: "configured Acme Work installer" });
          },
          assert: async () => {
            const text = await panelEval(ctx, "document.body.innerText");
            ctx.assert(text.includes(`${APP_NAME} Installer`), `Installer title missing from ${text.slice(0, 500)}`);
            ctx.assert(text.includes(`This sets up ${APP_NAME} for ${ORG_NAME}`), `Installer organization copy missing from ${text.slice(0, 500)}`);
            ctx.assert(text.includes("Configured via organization setup file"), "Installer did not report its adjacent organization setup file.");
          },
          screenshot: { name: "frame-3-acme-work-installer", sandboxCapture: true, textTargetUrlIncludes: "127.0.0.1", requireText: [`${APP_NAME} Installer`, `This sets up ${APP_NAME} for ${ORG_NAME}`] },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("After sign-in, the desktop title and sidebar apply Acme Work live", {
          voiceover: vo[3],
          action: async () => {
            await memberRefresh(ctx);
            await ctx.navigateHash("/session");
            await ctx.waitFor(`document.querySelector('[data-testid="brand-app-name"]')?.textContent?.trim() === '${APP_NAME}'`, { timeoutMs: 30_000, label: "Acme Work sidebar label" });
            await ctx.waitFor(`(() => { const image = document.querySelector('[data-testid="brand-logo"] img'); return Boolean(image?.complete && image?.naturalWidth > 0); })()`, { timeoutMs: 30_000, label: "Example Corp sidebar wordmark" });
          },
          assert: async () => {
            const title = await ctx.eval("document.title");
            ctx.assert(title === APP_NAME, `Renderer title was ${title}`);
            const nativeTitle = await nativeWindowTitle(ctx);
            ctx.assert(nativeTitle.includes(APP_NAME), `Native title was ${nativeTitle}`);
            state.updaterBefore = await ctx.eval("window.__OPENWORK_ELECTRON__?.updater?.getChannel?.()", { awaitPromise: true });
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "The Daytona OS window title contains Acme Work", actual: nativeTitle });
          },
          screenshot: { name: "frame-4-acme-work-desktop", requireText: [APP_NAME, "Search sessions"] },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Branding survives a fresh desktop process while app and updater identity remain OpenWork-compatible", {
          voiceover: vo[4],
          action: async () => {
            await relaunchDesktop(ctx);
            await memberRefresh(ctx);
            await ctx.navigateHash("/session");
            await ctx.waitFor(`document.querySelector('[data-testid="brand-app-name"]')?.textContent?.trim() === '${APP_NAME}'`, { timeoutMs: 60_000, label: "Acme Work after relaunch" });
          },
          assert: async () => {
            const config = await waitForDesktopConfig(ctx, "Acme Work after relaunch", (body) => body.brandAppName === APP_NAME && body.brandLogoUrl === state.logoUrl);
            const identity = await signedIdentity(ctx);
            ctx.assert(/com\.differentai\.openwork(?:\.dev)?/.test(identity), `Unexpected application identity: ${identity}`);
            ctx.assert(!identity.includes("acme-work"), `Display name leaked into signed identity: ${identity}`);
            const updaterAfter = await ctx.eval("window.__OPENWORK_ELECTRON__?.updater?.getChannel?.()", { awaitPromise: true });
            ctx.assert(updaterAfter?.channel === state.updaterBefore?.channel, `Updater channel changed: ${JSON.stringify({ before: state.updaterBefore, after: updaterAfter })}`);
            ctx.assert(updaterAfter?.feedUrl === state.updaterBefore?.feedUrl, `Updater feed changed: ${JSON.stringify({ before: state.updaterBefore, after: updaterAfter })}`);
            ctx.assert(config.brandAppName === APP_NAME, "Server-managed display branding did not survive the new desktop process.");
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Fresh desktop process retains Acme Work while the app identifier and updater feed remain unchanged", actual: JSON.stringify({ identity: JSON.parse(identity), updaterBefore: state.updaterBefore, updaterAfter }) });
          },
          screenshot: { name: "frame-5-branding-survives-relaunch", requireText: [APP_NAME, "Search sessions"] },
        });
      },
    },
  ],
};
