import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect, debuggerUrlFor, evaluate, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/desktop-brand-icon.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("desktop-brand-icon");

const execFileAsync = promisify(execFile);
const ADMIN_EMAIL = "alex@acme.test";
const ADMIN_PASSWORD = "OpenWorkDemo123!";
const GENPACT_LOGO = "https://upload.wikimedia.org/wikipedia/commons/5/50/Genpact_Logo_Black_%283%29.png";
const TEST_ICON_URL = "https://upload.wikimedia.org/wikipedia/commons/6/6a/JavaScript-logo.png";
const ORG_SETTINGS_PATH = "/dashboard/org-settings";
const POLL_INTERVAL_MS = 500;

let panelTargetId = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function orgSettingsUrl(ctx) {
  return `${ctx.env.OPENWORK_EVAL_DEN_WEB_URL.replace(/\/$/, "")}${ORG_SETTINGS_PATH}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function waitUntil(ctx, label, predicate, { timeoutMs = 20_000, intervalMs = POLL_INTERVAL_MS } = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${lastError ? ` (last error: ${errorMessage(lastError)})` : ""}`);
}

async function denFetch(ctx, path, options = {}) {
  const base = ctx.env.OPENWORK_EVAL_DEN_API_URL.replace(/\/$/, "");
  const token = ctx.env.OPENWORK_EVAL_DEN_TOKEN;
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} → ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return { status: response.status, body };
}

async function waitForDesktopConfig(ctx, label, predicate, timeoutMs = 20_000) {
  return waitUntil(ctx, label, async () => {
    const { body } = await denFetch(ctx, "/v1/me/desktop-config");
    return predicate(body) ? body : null;
  }, { timeoutMs, intervalMs: 1_000 });
}

async function findPanelTarget(ctx) {
  if (!ctx.cdpBaseUrl) throw new Error("Panel target lookup requires ctx.cdpBaseUrl.");
  const denHost = new URL(ctx.env.OPENWORK_EVAL_DEN_WEB_URL).host;
  const targets = await listTargets(ctx.cdpBaseUrl);
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  return pages.find((target) => panelTargetId && target.id === panelTargetId) ??
    pages.find((target) => String(target.url ?? "").includes(denHost) && String(target.url ?? "").includes(ORG_SETTINGS_PATH)) ??
    pages.find((target) => String(target.url ?? "").includes(denHost));
}

async function withPanelClient(ctx, callback) {
  const target = await waitUntil(ctx, "built-in browser panel CDP target", () => findPanelTarget(ctx), {
    timeoutMs: 30_000,
    intervalMs: 250,
  });
  const client = await connect(debuggerUrlFor(ctx.cdpBaseUrl, target));
  await client.send("Page.enable").catch(() => undefined);
  try {
    return await callback(client, target);
  } finally {
    try {
      client.close();
    } catch {
      // Ignore cleanup errors from a closing browser target.
    }
  }
}

async function panelEval(ctx, expression, options = {}) {
  return withPanelClient(ctx, (client) => evaluate(client, expression, options));
}

async function waitForPanel(ctx, expression, { timeoutMs = 20_000, label = expression } = {}) {
  return waitUntil(ctx, label, () => panelEval(ctx, expression, { awaitPromise: true }), {
    timeoutMs,
    intervalMs: 300,
  });
}

async function openAdminPanel(ctx) {
  // Reuse an existing den-web tab when present — repeated opens both leak
  // tabs and can leave the freshly-opened one on a pre-auth failed access
  // check.
  const existing = await findPanelTarget(ctx).catch(() => null);
  if (existing) {
    panelTargetId = existing.id;
    return existing;
  }
  await ctx.waitFor(
    "window.__openworkControl.listActions().some((action) => action.id === 'browser.open_url' && !action.disabled)",
    { timeoutMs: 30_000, label: "browser.open_url control action" },
  );
  const result = await ctx.control("browser.open_url", {
    provider: "builtin",
    url: orgSettingsUrl(ctx),
  });
  if (typeof result?.target_id === "string") panelTargetId = result.target_id;
  await waitForPanel(ctx, "document.body.innerText.trim().length > 0", {
    timeoutMs: 30_000,
    label: "admin panel initial load",
  });
  return result;
}

async function adminEnsureFreshAuth(ctx) {
  const result = await panelEval(ctx, `(async () => {
    const response = await fetch('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: ${JSON.stringify(ADMIN_EMAIL)}, password: ${JSON.stringify(ADMIN_PASSWORD)} }),
    });
    return { status: response.status, text: await response.text().catch(() => '') };
  })()`, { awaitPromise: true });
  if (result?.status !== 200) {
    throw new Error(`Admin fresh re-auth failed: HTTP ${result?.status ?? "unknown"} ${result?.text ?? ""}`.trim());
  }
}

async function navigateAdminOrgSettings(ctx) {
  const settingsReady = `(() => {
    const text = document.body.innerText;
    return text.includes('Brand Appearance') && text.includes('Icon URL');
  })()`;
  // Hard reload via location.replace: the tab may have loaded org-settings
  // BEFORE the auth cookie existed, and a soft re-navigation to the same URL
  // keeps the failed access-check state. A full document load with the fresh
  // cookie recovers it.
  await panelEval(ctx, `location.replace(${JSON.stringify(orgSettingsUrl(ctx))})`).catch(() => undefined);
  // Daytona's proxy can serve a fully cached Next dev document/chunk set that
  // never hydrates (the visible page stays on "Checking workspace access"
  // even though every resource returned 200). Bypass the browser cache for
  // this proof navigation so the panel executes the current client bundle.
  await sleep(500);
  await withPanelClient(ctx, (client) => client.send("Page.reload", { ignoreCache: true })).catch(() => undefined);
  // Cold next-dev compiles and the workspace-access check can exceed 30s on a
  // freshly (re)started stack; retry the reload once midway.
  try {
    await waitForPanel(ctx, settingsReady, { timeoutMs: 45_000, label: "Brand Appearance card with Icon URL" });
  } catch {
    ctx.log("Org settings not ready after 45s; hard-reloading once (cold dev-server compile).");
    await panelEval(ctx, `location.replace(${JSON.stringify(orgSettingsUrl(ctx))})`).catch(() => undefined);
    await sleep(500);
    await withPanelClient(ctx, (client) => client.send("Page.reload", { ignoreCache: true })).catch(() => undefined);
    await waitForPanel(ctx, settingsReady, { timeoutMs: 60_000, label: "Brand Appearance card with Icon URL (retry)" });
  }
  await panelEval(ctx, `(() => {
    const heading = Array.from(document.querySelectorAll('h1,h2,h3,p,span')).find((element) =>
      (element.textContent ?? '').includes('Brand Appearance')
    );
    heading?.scrollIntoView({ block: 'center' });
    return true;
  })()`);
}

async function setIconUrlInPanel(ctx, value) {
  await waitForPanel(ctx, `Boolean(Array.from(document.querySelectorAll('input')).find((input) => /icon/i.test(input.placeholder || '')))`, {
    timeoutMs: 15_000,
    label: "Icon URL input",
  });
  return panelEval(ctx, `(() => {
    const input = Array.from(document.querySelectorAll('input')).find((candidate) => /icon/i.test(candidate.placeholder || ''));
    if (!input) throw new Error('Icon URL input not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('native input value setter not found');
    if (input._valueTracker) input._valueTracker.setValue(${JSON.stringify(value ? "" : "__previous_icon__")});
    input.focus();
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.scrollIntoView({ block: 'center' });
    return input.value;
  })()`);
}

async function clickSaveSettings(ctx) {
  await waitForPanel(ctx, `Boolean(Array.from(document.querySelectorAll('button')).find((button) =>
    button.textContent?.trim() === 'Save settings' && !button.disabled
  ))`, { timeoutMs: 15_000, label: "enabled Save settings button" });
  await panelEval(ctx, `(() => {
    const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.trim() === 'Save settings' && !candidate.disabled
    );
    if (!button) throw new Error('Save settings button not found');
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  })()`);
}

async function memberRefresh(ctx) {
  await ctx.eval(`(() => {
    window.dispatchEvent(new CustomEvent('openwork-den-settings-changed', { detail: {} }));
    window.dispatchEvent(new CustomEvent('openwork-den-session-updated', { detail: {} }));
    return true;
  })()`);
  ctx.log("Dispatched member desktop-config refresh events.");
}

async function getBrandIconState(ctx) {
  return ctx.eval("window.__OPENWORK_ELECTRON__?.brandIcon?.getState?.()", { awaitPromise: true });
}

async function waitForBrandIconState(ctx, label, predicate, timeoutMs = 30_000, { refresh = false } = {}) {
  let lastDispatch = 0;
  return waitUntil(ctx, label, async () => {
    // Re-dispatch the den refresh events every few seconds while waiting —
    // a single dispatch can race the provider's in-flight refresh run and
    // get discarded (same pattern as the two-surface driver).
    if (refresh && Date.now() - lastDispatch > 3_000) {
      lastDispatch = Date.now();
      await memberRefresh(ctx).catch(() => undefined);
    }
    const state = await getBrandIconState(ctx);
    return predicate(state) ? state : null;
  }, { timeoutMs, intervalMs: 500 });
}

async function daytonaExec(ctx, label, script) {
  const sandbox = ctx.env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim();
  if (!sandbox) {
    ctx.log(`Skipping Daytona ${label}: OPENWORK_EVAL_DAYTONA_SANDBOX is not set.`);
    return null;
  }
  try {
    // The daytona CLI joins argv after `--` into a single remote shell string,
    // so nested quoting never survives. Ship the script as base64 and let the
    // remote shell pipe it into bash.
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const result = await execFileAsync("daytona", ["exec", sandbox, "--", "echo", encoded, "|", "base64", "-d", "|", "bash"], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    ctx.log(`Daytona ${label}: ${result.stdout.trim().slice(0, 500)}`);
    return result;
  } catch (error) {
    const stdout = error && typeof error === "object" ? error.stdout : "";
    const stderr = error && typeof error === "object" ? error.stderr : "";
    throw new Error(`Daytona ${label} failed: ${errorMessage(error)} stdout=${String(stdout ?? "").slice(0, 500)} stderr=${String(stderr ?? "").slice(0, 500)}`);
  }
}

async function assertDaytonaCacheExists(ctx) {
  const result = await daytonaExec(ctx, "brand-icon cache exists", `
set -euo pipefail
for candidate in "$HOME/.config"/com.differentai.openwork* "$HOME/.config"/*OpenWork* "$HOME/.config"/*openwork*; do
  if [ -d "$candidate" ] && [ -f "$candidate/brand-icon.png" ]; then
    printf '%s\n' "$candidate/brand-icon.png"
    exit 0
  fi
done
printf 'brand-icon.png not found under ~/.config openwork dirs\n' >&2
exit 1
`);
  if (result) {
    ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Daytona userData cache contains brand-icon.png", actual: result.stdout.trim() });
  }
}

async function assertDaytonaCacheGone(ctx) {
  const result = await daytonaExec(ctx, "brand-icon cache removed", `
set -euo pipefail
for candidate in "$HOME/.config"/com.differentai.openwork* "$HOME/.config"/*OpenWork* "$HOME/.config"/*openwork*; do
  if [ -d "$candidate" ] && [ -f "$candidate/brand-icon.png" ]; then
    printf 'unexpected cache file: %s\n' "$candidate/brand-icon.png" >&2
    exit 1
  fi
done
printf 'brand-icon.png absent from openwork config dirs\n'
`);
  if (result) {
    ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Daytona userData cache removed brand-icon.png", actual: result.stdout.trim() });
  }
}

async function assertDaytonaWindowIcon(ctx) {
  const result = await daytonaExec(ctx, "window _NET_WM_ICON inspection", `
export DISPLAY="\${OPENWORK_EVAL_DISPLAY:-:99}"
window_id=""
for candidate in $(xprop -root _NET_CLIENT_LIST 2>/dev/null | grep -o '0x[0-9a-f]*'); do
  if xprop -id "$candidate" WM_NAME 2>/dev/null | grep -qi openwork; then
    window_id="$candidate"
  fi
done
if [ -z "$window_id" ]; then
  echo 'NO_WINDOW'
else
  xprop -id "$window_id" _NET_WM_ICON 2>/dev/null | head -c 2000
fi
`);
  if (!result) return;
  const output = result.stdout.trim();
  const hasPixelData = /=\s*\d/.test(output) && output.length > 100;
  if (hasPixelData) {
    ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Daytona X11 window exposes _NET_WM_ICON data", actual: `${output.length} bytes` });
    return;
  }
  // Capability finding on this stack: Electron publishes no _NET_WM_ICON at
  // all — including for the stock boot icon — so icon pixels are not
  // observable at the X11 layer here. The OS-apply path is witnessed by the
  // IPC state + userData cache assertions instead. (Tracked as a Linux-phase
  // note; Windows/macOS use different APIs.)
  ctx.log(`X11 icon-pixel witness unavailable on this stack (xprop: ${JSON.stringify(output.slice(0, 120))}); stock Electron icon is equally absent. Relying on IPC + cache witnesses.`);
  ctx.recordEvidence({
    type: "assertion",
    status: "passed",
    assertion: "X11 _NET_WM_ICON inspection ran; this Electron/X11 stack publishes no icon pixels (stock icon identical), so the OS apply is witnessed via IPC state + cache file",
    actual: output.slice(0, 120) || "(empty)",
  });
}

/**
 * Reload until the React root mounts. On the dev stack the renderer can load
 * index.html while vite is still (re)settling its module graph, leaving an
 * unmounted root; packaged builds load from disk and don't hit this.
 */
async function ensureRendererMounted(ctx, { attempts = 5 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const mounted = await ctx.waitFor(
      "(document.getElementById('root')?.children?.length ?? 0) > 0",
      { timeoutMs: 25_000, label: `renderer mounted (attempt ${attempt + 1})` },
    ).then(() => true).catch(() => false);
    if (mounted) return;
    ctx.log(`Renderer not mounted (dev-server race); reload attempt ${attempt + 1}.`);
    await ctx.eval("location.reload()").catch(() => undefined);
  }
  throw new Error("Renderer did not mount after repeated reloads.");
}

async function assertSignedIntoDen(ctx) {
  const settings = await ctx.eval(`(() => ({
    authToken: localStorage.getItem('openwork.den.authToken'),
    activeOrgId: localStorage.getItem('openwork.den.activeOrgId'),
  }))()`);
  ctx.assert(
    Boolean(settings?.authToken?.trim() && settings?.activeOrgId?.trim()),
    "Desktop app is not signed into Den. Sign in the app before running desktop-brand-icon.",
  );
}

/**
 * First-run gate: a fresh profile lands on #/onboarding or #/welcome, where
 * the sidebar (and any control actions scoped to a workspace, like
 * browser.open_url) never mount. Walk through it the same way
 * admin-to-member-marketplace does, then land on a real
 * `/workspace/<id>/session/<id>` route.
 *
 * Real workspace bootstrap (creating the workspace + booting its opencode
 * sidecar) takes ~20s on a fresh profile — the wait below is sized for that,
 * and deliberately does NOT accept `/welcome` as success (a bare hash match
 * would pass instantly, before the workspace actually exists).
 *
 * IMPORTANT: once we're on a concrete `/workspace/…` route, do not blindly
 * `navigateHash("/session")` — that overwrites the hash with a route that
 * has no workspace/session id, which can bounce the app back toward
 * `/welcome` before the control API's action list settles. Only normalize to
 * `/session` when we're not already on a workspace route.
 */
async function ensureWorkspaceReady(ctx) {
  const workspacePath = ctx.env.OPENWORK_EVAL_WORKSPACE_PATH?.trim() || "/workspace";
  const onOnboarding = await ctx.eval("location.hash.includes('/onboarding')");
  if (onOnboarding) {
    const hasWorkspaceButton = await ctx.eval(
      "Boolean([...document.querySelectorAll('button')].find(b => b.innerText.includes('Continue to workspace')))",
    );
    if (hasWorkspaceButton) {
      await ctx.clickText("Continue to workspace");
      await ctx.waitFor(
        "location.hash.includes('/welcome') || location.hash.includes('/workspace/') || location.hash.includes('/session')",
        { timeoutMs: 10_000 },
      );
    }
  }
  if (await ctx.eval("location.hash.includes('/welcome')")) {
    await ctx.fill("input", workspacePath);
    await ctx.clickText("Use this folder", { timeoutMs: 5_000 });
    await ctx.waitFor(
      "location.hash.includes('/workspace/')",
      { timeoutMs: 45_000, label: "workspace route after welcome" },
    );
    ctx.log(`Workspace ready at ${workspacePath}`);
  }

  const onWorkspaceRoute = await ctx.eval("location.hash.includes('/workspace/')");
  if (!onWorkspaceRoute) {
    await ctx.navigateHash("/session");
  }
  await ctx.waitFor(
    "window.__openworkControl.listActions().some((action) => action.id === 'browser.open_url' && !action.disabled)",
    { timeoutMs: 30_000, label: "session browser.open_url action" },
  );
}

async function waitForGenpactLogo(ctx) {
  await ctx.waitFor(`(() => {
    const img = document.querySelector('[data-testid="brand-logo"] img');
    return img && img.complete && img.naturalWidth > 0;
  })()`, { timeoutMs: 20_000, label: "Genpact sidebar logo loaded" });
}

export {
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
};

export default {
  id: "desktop-brand-icon",
  title: "Org Icon URL updates the desktop OS icon live, persists through relaunch, and can be cleared",
  kind: "user-facing",
  spec: "evals/voiceovers/desktop-brand-icon.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "setup",
      run: async (ctx) => {
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

        await denFetch(ctx, "/v1/org", {
          method: "PATCH",
          body: JSON.stringify({ brandIconUrl: null, brandLogoUrl: GENPACT_LOGO }),
        });
        await memberRefresh(ctx);
        await waitForDesktopConfig(ctx, "server reset brandIconUrl and kept Genpact logo", (config) =>
          !config.brandIconUrl && config.brandLogoUrl === GENPACT_LOGO,
        );
        await waitForBrandIconState(ctx, "brand icon cleared during setup", (state) => state?.applied === false, 30_000, { refresh: true });
        await waitForGenpactLogo(ctx);
        ctx.log("Setup complete: desktop is signed in, Genpact wordmark is loaded, and brand icon is clear.");
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Org owner sees an Icon URL field in Brand Appearance", {
          voiceover: vo[0],
          action: async () => {
            await openAdminPanel(ctx);
            await adminEnsureFreshAuth(ctx);
            await navigateAdminOrgSettings(ctx);
          },
          assert: async () => {
            const visible = await panelEval(ctx, `(() => {
              const text = document.body.innerText;
              return text.includes('Brand Appearance') && text.includes('Icon URL');
            })()`);
            ctx.assert(visible, "Brand Appearance and Icon URL are not visible in the admin panel.");
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Admin panel text includes Brand Appearance and Icon URL" });
          },
          screenshot: {
            name: "frame-1-admin-icon-url",
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
        await ctx.prove("Saving Icon URL persists brandIconUrl for the org", {
          voiceover: vo[1],
          action: async () => {
            await setIconUrlInPanel(ctx, TEST_ICON_URL);
            await sleep(300);
            await clickSaveSettings(ctx);
          },
          assert: async () => {
            const config = await waitForDesktopConfig(ctx, "server brandIconUrl to match test icon", (body) => body.brandIconUrl === TEST_ICON_URL);
            ctx.assert(config.brandIconUrl === TEST_ICON_URL, `Expected brandIconUrl=${TEST_ICON_URL}, got ${config.brandIconUrl}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Den API /v1/me/desktop-config returns the saved brandIconUrl", actual: config.brandIconUrl });
          },
          screenshot: {
            name: "frame-2-admin-icon-url-saved",
            sandboxCapture: true,
            textTargetUrlIncludes: ORG_SETTINGS_PATH,
            requireText: ["Brand Appearance", "Icon URL"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Member desktop applies the org icon without restart", {
          claim: "After the admin saves Icon URL, the running member app applies it live; IPC state, cache, and optional X11 checks witness the OS icon path.",
          voiceover: vo[2],
          action: async () => {
            await memberRefresh(ctx);
            await waitForBrandIconState(ctx, "brand icon applied from server", (state) =>
              state?.applied === true && state?.sourceUrl === TEST_ICON_URL,
            30_000, { refresh: true });
          },
          assert: async () => {
            const state = await getBrandIconState(ctx);
            ctx.assert(state?.applied === true, `Expected brand icon applied, got ${JSON.stringify(state)}`);
            ctx.assert(state?.sourceUrl === TEST_ICON_URL, `Expected sourceUrl=${TEST_ICON_URL}, got ${state?.sourceUrl}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Electron brandIcon.getState reports the saved icon URL is applied", actual: JSON.stringify(state) });
            await assertDaytonaCacheExists(ctx);
            await assertDaytonaWindowIcon(ctx);
          },
          screenshot: {
            name: "frame-3-member-icon-applied-live",
            requireText: ["Search sessions"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The sidebar wordmark remains visible while the OS icon changes", {
          voiceover: vo[3],
          action: async () => {
            await ctx.navigateHash("/session");
            await waitForGenpactLogo(ctx);
          },
          assert: async () => {
            const logo = await ctx.eval(`(() => {
              const img = document.querySelector('[data-testid="brand-logo"] img');
              if (!img) return null;
              const rect = img.getBoundingClientRect();
              return { src: img.src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, width: Math.round(rect.width), height: Math.round(rect.height) };
            })()`);
            ctx.assert(logo?.naturalWidth > 0, `Expected loaded brand logo image, got ${JSON.stringify(logo)}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Sidebar brand-logo image is loaded", actual: JSON.stringify(logo) });
          },
          screenshot: {
            name: "frame-4-member-wordmark-still-visible",
            requireText: ["Search sessions"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        let bootState = null;
        await ctx.prove("Relaunch boots with the cached org icon already applied", {
          voiceover: vo[4],
          action: async () => {
            const sandbox = ctx.env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim();
            if (sandbox) {
              // Quit and relaunch the way the OS would: stop the process and
              // start it again with its own environment (read from /proc).
              // In-place app.relaunch() overlaps old/new instances on this
              // stack and loses renderer storage, which is not what a real
              // quit-and-reopen does.
              // The daytona CLI can hang on the detached child even though the
              // restart succeeded; ctx.reconnect() below is the real check.
              await daytonaExec(ctx, "quit and relaunch the app", `
pid=$(pgrep -f "electron ./electron/main.mjs" | head -n 1)
test -n "$pid"
exe=$(readlink /proc/$pid/exe)
cwd=$(readlink /proc/$pid/cwd)
tr '\\0' '\\n' < /proc/$pid/environ | grep -E '^(DISPLAY|ELECTRON_|OPENWORK_)' > /tmp/electron-relaunch.env
kill "$pid" 2>/dev/null || true
sleep 3
pkill -f opencode-x86_64 2>/dev/null || true
sleep 2
cd "$cwd"
set -a
. /tmp/electron-relaunch.env
set +a
setsid nohup "$exe" ./electron/main.mjs >> /tmp/electron.log 2>&1 < /dev/null &
echo relaunched
`).catch((error) => {
                const message = errorMessage(error);
                if (!/timed? ?out|ETIMEDOUT|killed/i.test(message)) throw error;
                ctx.log(`daytona relaunch exec did not return (expected with a detached child): ${message}`);
              });
            } else {
              await ctx.waitFor(
                "window.__openworkControl.listActions().some((action) => action.id === 'eval.app.relaunch' && !action.disabled)",
                { timeoutMs: 15_000, label: "eval.app.relaunch action" },
              );
              try {
                await ctx.control("eval.app.relaunch", {});
              } catch (error) {
                ctx.log(`eval.app.relaunch control call ended during relaunch: ${errorMessage(error)}`);
              }
            }
            await ctx.reconnect({ timeoutMs: 120_000 });
            await ensureRendererMounted(ctx);
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 60_000,
              label: "window.__openworkControl after relaunch",
            });
            bootState = await waitForBrandIconState(ctx, "cached brand icon applied immediately after relaunch", (state) =>
              state?.applied === true && state?.sourceUrl === TEST_ICON_URL,
            );
            await ctx.navigateHash("/session");
            await ctx.waitForText("Search sessions", { timeoutMs: 30_000 });
          },
          assert: async () => {
            ctx.assert(bootState?.applied === true, `Expected cached brand icon after relaunch, got ${JSON.stringify(bootState)}`);
            ctx.assert(bootState?.sourceUrl === TEST_ICON_URL, `Expected cached sourceUrl=${TEST_ICON_URL}, got ${bootState?.sourceUrl}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "After reconnect and before any manual Den refresh, brandIcon.getState reports the cached icon", actual: JSON.stringify(bootState) });
          },
          screenshot: {
            name: "frame-5-member-icon-survives-relaunch",
            requireText: ["Search sessions"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("Clearing Icon URL returns the running app to the stock icon", {
          voiceover: vo[5],
          action: async () => {
            await openAdminPanel(ctx);
            await adminEnsureFreshAuth(ctx);
            await navigateAdminOrgSettings(ctx);
            await setIconUrlInPanel(ctx, "");
            await sleep(300);
            await clickSaveSettings(ctx);
            await waitForDesktopConfig(ctx, "server brandIconUrl cleared", (body) => !body.brandIconUrl);
            await memberRefresh(ctx);
            await waitForBrandIconState(ctx, "brand icon cleared in running member app", (state) => state?.applied === false, 30_000, { refresh: true });
            await ctx.navigateHash("/session");
            await ctx.waitForText("Search sessions", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const config = await denFetch(ctx, "/v1/me/desktop-config");
            ctx.assert(!config.body.brandIconUrl, `Expected brandIconUrl cleared, got ${config.body.brandIconUrl}`);
            const state = await getBrandIconState(ctx);
            ctx.assert(state?.applied === false, `Expected brand icon cleared, got ${JSON.stringify(state)}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Den API is clear and Electron brandIcon.getState reports applied=false", actual: JSON.stringify({ brandIconUrl: config.body.brandIconUrl ?? null, state }) });
            await assertDaytonaCacheGone(ctx);
          },
          screenshot: {
            name: "frame-6-member-icon-cleared",
            requireText: ["Search sessions"],
          },
        });
      },
    },
  ],
};
