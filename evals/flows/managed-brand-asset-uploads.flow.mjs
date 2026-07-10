import { createHash } from "node:crypto";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import {
  ORG_SETTINGS_PATH,
  adminEnsureFreshAuth,
  clickSaveSettings,
  denFetch,
  ensureRendererMounted,
  ensureWorkspaceReady,
  getPanelTargetId,
  memberRefresh,
  openAdminPanel,
  panelEval,
  sleep,
  waitForBrandIconState,
  waitForDesktopConfig,
  waitForPanel,
  waitUntil,
} from "./desktop-brand-icon.flow.mjs";

// Narration is loaded from the approved script (evals/voiceovers/managed-brand-asset-uploads.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("managed-brand-asset-uploads");
const ADMIN_PASSWORD = "OpenWorkDemo123!";
const RAW_REAUTH_MESSAGE = "For security, confirm it's you before changing workspace settings.";

let firstAssets = null;
let firstIconBytes = null;
let adminPanelTargetId = null;

function orgSettingsUrl(ctx) {
  return `${ctx.env.OPENWORK_EVAL_DEN_WEB_URL.replace(/\/$/, "")}${ORG_SETTINGS_PATH}`;
}

function parseMetadata(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function readManagedAssets(ctx) {
  const { body } = await denFetch(ctx, "/v1/org");
  const metadata = parseMetadata(body?.organization?.metadata);
  return {
    logo: metadata.brandLogoAsset ?? null,
    icon: metadata.brandIconAsset ?? null,
    logoUrl: metadata.brandLogoUrl ?? null,
    iconUrl: metadata.brandIconUrl ?? null,
  };
}

async function ensureDesktopSession(ctx) {
  const { body } = await denFetch(ctx, "/v1/me/orgs");
  const organizations = Array.isArray(body?.orgs) ? body.orgs : [];
  const activeOrg = organizations.find((organization) => organization?.id === body?.activeOrgId) ?? organizations[0];
  ctx.assert(activeOrg?.id, "The eval token does not have an organization.");

  await denFetch(ctx, "/v1/org", {
    method: "PATCH",
    body: JSON.stringify({ name: "Example Corp", brandLogoUrl: null, brandIconUrl: null }),
  });

  await ctx.eval(`(() => {
    localStorage.setItem('openwork.den.baseUrl', ${JSON.stringify(process.env.OPENWORK_EVAL_DEN_WEB_URL)});
    localStorage.setItem('openwork.den.apiBaseUrl', ${JSON.stringify(process.env.OPENWORK_EVAL_DEN_API_URL)});
    localStorage.setItem('openwork.den.authToken', ${JSON.stringify(process.env.OPENWORK_EVAL_DEN_TOKEN)});
    localStorage.setItem('openwork.den.activeOrgId', ${JSON.stringify(activeOrg.id)});
    localStorage.setItem('openwork.den.activeOrgSlug', ${JSON.stringify(activeOrg.slug ?? "example-corp")});
    localStorage.setItem('openwork.den.activeOrgName', 'Example Corp');
    window.dispatchEvent(new CustomEvent('openwork-den-settings-changed', { detail: {} }));
    window.dispatchEvent(new CustomEvent('openwork-den-session-updated', { detail: { token: ${JSON.stringify(process.env.OPENWORK_EVAL_DEN_TOKEN)} } }));
    return true;
  })()`);

  await waitUntil(ctx, "desktop Den session", async () => {
    const status = await ctx.control("auth.status", {}).catch(() => null);
    return status?.status === "signed_in" ? status : null;
  }, { timeoutMs: 30_000 });
}

async function stageBrandUploadReauthResponse(ctx) {
  await panelEval(ctx, `(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const [input, init] = args;
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method === 'POST' && url.includes('/api/den/v1/org/brand-assets')) {
        window.fetch = originalFetch;
        window.__openworkBrandReauthIntercepted = true;
        return new Response(${JSON.stringify(JSON.stringify({
          error: "reauth",
          reason: "fresh_auth_required",
          message: RAW_REAUTH_MESSAGE,
        }))}, {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(...args);
    };
    return true;
  })()`);
}

async function verifyPasswordInPanel(ctx) {
  await panelEval(ctx, `(() => {
    const input = document.querySelector('input[autocomplete="current-password"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('Reauth password input not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Native password setter not found');
    setter.call(input, ${JSON.stringify(ADMIN_PASSWORD)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === 'Verify password');
    if (!button || button.disabled) throw new Error('Verify password button not available');
    button.click();
    return true;
  })()`);
}

async function navigateBrandSettings(ctx) {
  await panelEval(ctx, `location.replace(${JSON.stringify(orgSettingsUrl(ctx))})`).catch(() => undefined);
  const ready = `(() => {
    const text = document.body.innerText;
    return text.includes('Brand Appearance') && text.includes('Wordmark') && text.includes('Square app icon');
  })()`;
  try {
    await waitForPanel(ctx, ready, { timeoutMs: 45_000, label: "managed Brand Appearance fields" });
  } catch {
    await panelEval(ctx, `location.replace(${JSON.stringify(orgSettingsUrl(ctx))})`).catch(() => undefined);
    await waitForPanel(ctx, ready, { timeoutMs: 60_000, label: "managed Brand Appearance fields after reload" });
  }
  await panelEval(ctx, `(() => {
    document.querySelector('[data-testid="brand-logo-asset-field"]')?.scrollIntoView({ block: 'center' });
    return true;
  })()`);
}

async function selectGeneratedAsset(ctx, kind, variant) {
  const result = await panelEval(ctx, `(async () => {
    const kind = ${JSON.stringify(kind)};
    const variant = ${JSON.stringify(variant)};
    const invalidWideIcon = kind === 'icon' && variant === 'invalid-wide';
    const width = kind === 'logo' || invalidWideIcon ? 640 : 256;
    const height = kind === 'logo' || invalidWideIcon ? 160 : 256;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable');
    context.fillStyle = variant === 'replacement' ? '#0f766e' : invalidWideIcon ? '#b91c1c' : '#123f73';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#ffffff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = kind === 'logo' || invalidWideIcon ? 'bold 58px sans-serif' : 'bold 92px sans-serif';
    context.fillText(kind === 'logo' ? 'EXAMPLE CORP' : invalidWideIcon ? 'NOT A SQUARE ICON' : 'BY', width / 2, height / 2);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png'));
    const suffix = variant === 'replacement' ? '-v2' : invalidWideIcon ? '-wide' : '';
    const file = new File([blob], 'example-corp-' + kind + suffix + '.png', { type: 'image/png' });
    const input = document.querySelector('#brand-' + kind + '-upload');
    if (!(input instanceof HTMLInputElement)) throw new Error('Brand asset file input not found');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.closest('[data-testid]')?.scrollIntoView({ block: 'center' });
    return { name: file.name, size: file.size, width, height };
  })()`, { awaitPromise: true });
  ctx.log(`Selected ${kind} fixture: ${JSON.stringify(result)}`);
}

async function waitForReadyDrafts(ctx) {
  return waitForPanel(ctx, `(() => {
    const logo = document.querySelector('[data-testid="brand-logo-status"]')?.textContent ?? '';
    const icon = document.querySelector('[data-testid="brand-icon-status"]')?.textContent ?? '';
    const previews = Array.from(document.querySelectorAll('[data-testid$="-preview"]'));
    return logo.includes('Ready to upload') && icon.includes('Ready to upload') && previews.length === 2 && previews.every((image) => image.complete && image.naturalWidth > 0);
  })()`, { timeoutMs: 15_000, label: "two validated brand asset previews" });
}

async function clearManagedAssetsInPanel(ctx) {
  await panelEval(ctx, `(() => {
    for (const kind of ['logo', 'icon']) {
      const field = document.querySelector('[data-testid="brand-' + kind + '-asset-field"]');
      const button = Array.from(field?.querySelectorAll('button') ?? []).find((candidate) => candidate.textContent?.trim() === 'Clear');
      if (!button || button.disabled) throw new Error('Enabled Clear button not found for ' + kind);
      button.click();
    }
    return true;
  })()`);
  await waitForPanel(ctx, `document.body.innerText.includes('Will restore the default after saving.')`, {
    timeoutMs: 10_000,
    label: "restore-default pending state",
  });
}

async function fetchAsset(url) {
  const response = await fetch(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    etag: response.headers.get("etag"),
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export default {
  id: "managed-brand-asset-uploads",
  title: "Owners upload durable, versioned brand assets that member desktops load from their Den",
  kind: "user-facing",
  spec: "evals/voiceovers/managed-brand-asset-uploads.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "setup",
      run: async (ctx) => {
        await ensureRendererMounted(ctx);
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000, label: "window.__openworkControl" });
        await ctx.ensureLightMode();
        await ensureDesktopSession(ctx);
        await ensureWorkspaceReady(ctx);
        await memberRefresh(ctx);
        await waitForDesktopConfig(ctx, "managed branding reset", (config) => !config.brandLogoUrl && !config.brandIconUrl);
        await openAdminPanel(ctx);
        await adminEnsureFreshAuth(ctx);
        await navigateBrandSettings(ctx);
        adminPanelTargetId = await getPanelTargetId(ctx);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The owner chooses a wordmark and square icon as local files", {
          voiceover: vo[0],
          action: async () => {
            await selectGeneratedAsset(ctx, "logo", "initial");
            await selectGeneratedAsset(ctx, "icon", "initial");
            await waitForReadyDrafts(ctx);
          },
          assert: async () => {
            const state = await panelEval(ctx, `(() => ({
              logo: document.querySelector('#brand-logo-upload')?.files?.[0]?.name ?? null,
              icon: document.querySelector('#brand-icon-upload')?.files?.[0]?.name ?? null,
              previewCount: document.querySelectorAll('[data-testid$="-preview"]').length,
            }))()`);
            ctx.assert(state?.logo === "example-corp-logo.png", `Unexpected wordmark file: ${JSON.stringify(state)}`);
            ctx.assert(state?.icon === "example-corp-icon.png", `Unexpected icon file: ${JSON.stringify(state)}`);
            ctx.assert(state?.previewCount === 2, `Expected two previews: ${JSON.stringify(state)}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Both local files are selected and previewed", actual: state });
          },
          screenshot: {
            name: "frame-1-local-brand-files",
            sandboxCapture: true,
            targetId: adminPanelTargetId,
            textTargetId: adminPanelTargetId,
            requireText: ["Brand Appearance", "Ready to upload: example-corp-logo.png", "Ready to upload: example-corp-icon.png"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The preview validates format, dimensions, and intended geometry before save", {
          voiceover: vo[1],
          action: async () => {
            await selectGeneratedAsset(ctx, "icon", "invalid-wide");
            await waitForPanel(ctx, `document.body.innerText.includes('Use a square image for the app icon.')`, {
              timeoutMs: 10_000,
              label: "square-icon validation message",
            });
            await panelEval(ctx, `(() => {
              document.querySelector('[data-testid="brand-asset-error"]')?.scrollIntoView({ block: 'center' });
              return true;
            })()`);
            await sleep(500);
          },
          assert: async () => {
            const state = await panelEval(ctx, `(() => ({
              error: document.querySelector('[data-testid="brand-asset-error"]')?.textContent?.trim() ?? '',
              iconStatus: document.querySelector('[data-testid="brand-icon-status"]')?.textContent?.trim() ?? '',
              iconPreviewLoaded: Boolean(document.querySelector('[data-testid="brand-icon-preview"]')?.naturalWidth),
            }))()`);
            ctx.assert(state?.error.includes("Use a square image for the app icon."), `Expected geometry error: ${JSON.stringify(state)}`);
            ctx.assert(state?.iconStatus.includes("256×256"), `Expected valid square draft to remain: ${JSON.stringify(state)}`);
            ctx.assert(state?.iconPreviewLoaded, `Expected icon preview to remain loaded: ${JSON.stringify(state)}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "A 640×160 file is rejected for icon use while the valid 256×256 preview remains", actual: state });
          },
          screenshot: {
            name: "frame-2-validation-and-previews",
            sandboxCapture: true,
            targetId: adminPanelTargetId,
            textTargetId: adminPanelTargetId,
            requireText: ["Ready to upload", "Use a square image for the app icon."],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("A stale Brand Appearance save opens the security check without leaking the server response", {
          voiceover: vo[2],
          action: async () => {
            await selectGeneratedAsset(ctx, "icon", "initial");
            await waitForReadyDrafts(ctx);
            await stageBrandUploadReauthResponse(ctx);
            await clickSaveSettings(ctx);
            await waitForPanel(ctx, `(() => {
              const dialog = document.querySelector('[role="dialog"]');
              const passwordInput = dialog?.querySelector('input[autocomplete="current-password"]');
              return Boolean(dialog && passwordInput && dialog.textContent?.includes("Confirm it's you to continue"));
            })()`, { timeoutMs: 30_000, label: "Brand Appearance password reauth dialog" });
          },
          assert: async () => {
            const state = await panelEval(ctx, `(() => {
              const dialog = document.querySelector('[role="dialog"]');
              const pageText = Array.from(document.body.children)
                .filter((element) => !element.querySelector('[role="dialog"]'))
                .map((element) => element.textContent ?? '')
                .join(' ');
              return {
                dialogText: dialog?.textContent ?? '',
                rawMessageOutsideDialog: pageText.includes(${JSON.stringify(RAW_REAUTH_MESSAGE)}),
                interceptedReauth: window.__openworkBrandReauthIntercepted === true,
                selectedLogo: document.querySelector('#brand-logo-upload')?.files?.[0]?.name ?? null,
                selectedIcon: document.querySelector('#brand-icon-upload')?.files?.[0]?.name ?? null,
              };
            })()`);
            ctx.assert(state.dialogText.includes("Confirm it's you to continue"), `Reauth dialog was missing: ${JSON.stringify(state)}`);
            ctx.assert(state.dialogText.includes("Signing in as"), `Polished account context was missing: ${JSON.stringify(state)}`);
            ctx.assert(!state.rawMessageOutsideDialog, `Raw reauth response leaked into the page: ${JSON.stringify(state)}`);
            ctx.assert(state.interceptedReauth, `The brand upload did not receive the staged production reauth response: ${JSON.stringify(state)}`);
            ctx.assert(state.selectedLogo === "example-corp-logo.png" && state.selectedIcon === "example-corp-icon.png", `Selected files were lost: ${JSON.stringify(state)}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "The polished security dialog replaces the raw reauth response and both selected files remain queued", actual: state });
          },
          screenshot: {
            name: "frame-3-brand-upload-security-check",
            sandboxCapture: true,
            targetId: adminPanelTargetId,
            textTargetId: adminPanelTargetId,
            requireText: ["SECURITY CHECK", "Confirm it's you to continue", "SIGNING IN AS", "Verify password"],
            rejectText: [RAW_REAUTH_MESSAGE],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Verifying once resumes the queued brand upload without reselecting files", {
          voiceover: vo[3],
          action: async () => {
            await verifyPasswordInPanel(ctx);
            firstAssets = await waitUntil(ctx, "managed asset metadata", async () => {
              const assets = await readManagedAssets(ctx);
              return assets.logo?.version && assets.icon?.version ? assets : null;
            }, { timeoutMs: 30_000, intervalMs: 750 });
            await waitForPanel(ctx, `document.body.innerText.includes('Stored in this Den')`, {
              timeoutMs: 30_000,
              label: "saved managed asset state",
            });
            await panelEval(ctx, `(() => {
              document.querySelector('[data-testid="brand-logo-asset-field"]')?.scrollIntoView({ block: 'center' });
              return true;
            })()`);
            await sleep(500);
          },
          assert: async () => {
            ctx.assert(firstAssets?.logoUrl === firstAssets?.logo?.url, "Wordmark URL and managed metadata diverged.");
            ctx.assert(firstAssets?.iconUrl === firstAssets?.icon?.url, "Icon URL and managed metadata diverged.");
            for (const asset of [firstAssets.logo, firstAssets.icon]) {
              const assetUrl = new URL(asset.url);
              ctx.assert(assetUrl.origin === new URL(ctx.env.OPENWORK_EVAL_DEN_API_URL).origin, `Asset escaped the Den origin: ${asset.url}`);
              ctx.assert(Boolean(assetUrl.searchParams.get("signature")), `Asset URL is not capability-signed: ${asset.url}`);
              const fetched = await fetchAsset(asset.url);
              ctx.assert(fetched.status === 200, `Signed asset returned ${fetched.status}`);
              ctx.assert(fetched.cacheControl?.includes("immutable"), `Missing immutable caching: ${fetched.cacheControl}`);
              const unsigned = new URL(asset.url);
              unsigned.search = "";
              ctx.assert((await fetch(unsigned)).status === 404, "Unsigned managed asset URL was readable.");
            }
            firstIconBytes = (await fetchAsset(firstAssets.icon.url)).bytes;
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Both assets have signed content-addressed Den URLs; unsigned access is rejected and signed responses are immutable", actual: { logo: firstAssets.logo.url, icon: firstAssets.icon.url } });
          },
          screenshot: {
            name: "frame-4-reauthenticated-upload-saved",
            sandboxCapture: true,
            targetId: adminPanelTargetId,
            textTargetId: adminPanelTargetId,
            requireText: ["Stored in this Den"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("The saved assets are available to every member through the Example Corp Den", {
          voiceover: vo[4],
          assert: async () => {
            ctx.assert(firstAssets?.logoUrl === firstAssets?.logo?.url, "Wordmark URL and managed metadata diverged.");
            ctx.assert(firstAssets?.iconUrl === firstAssets?.icon?.url, "Icon URL and managed metadata diverged.");
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Both managed asset URLs were committed to the organization after reauth", actual: { logo: firstAssets.logo.url, icon: firstAssets.icon.url } });
          },
          screenshot: {
            name: "frame-5-saved-in-example-corp-den",
            sandboxCapture: true,
            targetId: adminPanelTargetId,
            textTargetId: adminPanelTargetId,
            requireText: ["Stored in this Den"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("A member desktop loads both brand URLs only from its Den", {
          voiceover: vo[5],
          action: async () => {
            await ctx.eval("performance.clearResourceTimings()");
            await memberRefresh(ctx);
            await waitForDesktopConfig(ctx, "member managed brand URLs", (config) => config.brandLogoUrl === firstAssets.logo.url && config.brandIconUrl === firstAssets.icon.url);
            await waitForBrandIconState(ctx, "managed icon applied", (state) => state?.applied === true && state?.sourceUrl === firstAssets.icon.url, 30_000, { refresh: true });
            await ctx.waitFor(`(() => {
              const image = document.querySelector('[data-testid="brand-logo"] img');
              return image && image.complete && image.naturalWidth > 0;
            })()`, { timeoutMs: 30_000, label: "managed wordmark in member sidebar" });
          },
          assert: async () => {
            const desktop = await ctx.eval(`(() => {
              const image = document.querySelector('[data-testid="brand-logo"] img');
              return {
                src: image?.src ?? null,
                width: image?.naturalWidth ?? 0,
                brandResources: performance.getEntriesByType('resource').map((entry) => entry.name).filter((url) => url.includes('/v1/brand-assets/')),
              };
            })()`);
            const iconState = await ctx.eval("window.__OPENWORK_ELECTRON__?.brandIcon?.getState?.()", { awaitPromise: true });
            const denOrigin = new URL(ctx.env.OPENWORK_EVAL_DEN_API_URL).origin;
            ctx.assert(new URL(desktop.src).origin === denOrigin, `Wordmark did not load from Den: ${desktop.src}`);
            ctx.assert(desktop.width > 0, `Wordmark did not decode: ${JSON.stringify(desktop)}`);
            ctx.assert(iconState?.sourceUrl === firstAssets.icon.url && iconState?.applied === true, `Native icon did not load from Den: ${JSON.stringify(iconState)}`);
            ctx.assert(desktop.brandResources.every((url) => new URL(url).origin === denOrigin), `A brand resource used another origin: ${JSON.stringify(desktop.brandResources)}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Sidebar wordmark and native icon source URLs use only the configured Den API origin", actual: { desktop, iconState, denOrigin } });
          },
          screenshot: {
            name: "frame-6-member-desktop-den-branding",
            requireText: ["Search sessions"],
          },
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        let replacement = null;
        await ctx.prove("Replacing an asset creates a new immutable version without invalidating the old bytes", {
          voiceover: vo[6],
          action: async () => {
            await openAdminPanel(ctx);
            await adminEnsureFreshAuth(ctx);
            await navigateBrandSettings(ctx);
            await selectGeneratedAsset(ctx, "icon", "replacement");
            await waitForPanel(ctx, `document.querySelector('[data-testid="brand-icon-status"]')?.textContent?.includes('Ready to upload')`, {
              timeoutMs: 10_000,
              label: "replacement icon draft",
            });
            await clickSaveSettings(ctx);
            replacement = await waitUntil(ctx, "new managed icon version", async () => {
              const assets = await readManagedAssets(ctx);
              return assets.icon?.version && assets.icon.version !== firstAssets.icon.version ? assets.icon : null;
            }, { timeoutMs: 30_000, intervalMs: 750 });
            await waitForPanel(ctx, `document.querySelector('[data-testid="brand-icon-status"]')?.textContent?.includes('Stored in this Den')`, {
              timeoutMs: 30_000,
              label: "saved replacement icon state",
            });
            await panelEval(ctx, `(() => {
              document.querySelector('[data-testid="brand-icon-asset-field"]')?.scrollIntoView({ block: 'center' });
              return true;
            })()`);
            await sleep(500);
          },
          assert: async () => {
            const oldResult = await fetchAsset(firstAssets.icon.url);
            const newResult = await fetchAsset(replacement.url);
            ctx.assert(oldResult.status === 200 && newResult.status === 200, `Expected both versions to remain readable: old=${oldResult.status} new=${newResult.status}`);
            ctx.assert(replacement.version !== firstAssets.icon.version, "Replacement reused the old version.");
            ctx.assert(newResult.sha256 === replacement.version, `New content hash does not match URL version: ${newResult.sha256}`);
            ctx.assert(!newResult.bytes.equals(firstIconBytes), "Replacement bytes are identical to the first icon.");
            ctx.assert(oldResult.cacheControl?.includes("immutable") && newResult.cacheControl?.includes("immutable"), "Both versions must be immutable.");
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Replacement has a new SHA-256 URL while both old and new immutable bytes remain readable", actual: { oldVersion: firstAssets.icon.version, newVersion: replacement.version, oldSha256: oldResult.sha256, newSha256: newResult.sha256 } });
          },
          screenshot: {
            name: "frame-7-versioned-replacement",
            sandboxCapture: true,
            targetId: adminPanelTargetId,
            textTargetId: adminPanelTargetId,
            requireText: ["Stored in this Den"],
          },
        });
      },
    },
    {
      name: "Frame 8",
      run: async (ctx) => {
        await ctx.prove("Clearing managed assets restores default desktop branding", {
          voiceover: vo[7],
          action: async () => {
            await clearManagedAssetsInPanel(ctx);
            await sleep(250);
            await clickSaveSettings(ctx);
            await waitUntil(ctx, "managed branding cleared", async () => {
              const assets = await readManagedAssets(ctx);
              return !assets.logo && !assets.icon && !assets.logoUrl && !assets.iconUrl ? assets : null;
            }, { timeoutMs: 30_000, intervalMs: 750 });
            await memberRefresh(ctx);
            await waitForDesktopConfig(ctx, "member defaults restored", (config) => !config.brandLogoUrl && !config.brandIconUrl);
            await waitForBrandIconState(ctx, "native icon reset", (state) => state?.applied === false, 30_000, { refresh: true });
            await ctx.waitFor("!document.querySelector('[data-testid=\"brand-logo\"]')", { timeoutMs: 20_000, label: "sidebar wordmark removed" });
          },
          assert: async () => {
            const config = await denFetch(ctx, "/v1/me/desktop-config");
            const iconState = await ctx.eval("window.__OPENWORK_ELECTRON__?.brandIcon?.getState?.()", { awaitPromise: true });
            const logoPresent = await ctx.eval("Boolean(document.querySelector('[data-testid=\"brand-logo\"]'))");
            ctx.assert(!config.body.brandLogoUrl && !config.body.brandIconUrl, `Managed URLs were not cleared: ${JSON.stringify(config.body)}`);
            ctx.assert(iconState?.applied === false, `Native default icon was not restored: ${JSON.stringify(iconState)}`);
            ctx.assert(!logoPresent, "Sidebar wordmark remained after clearing.");
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Desktop config has no managed URLs, the sidebar wordmark is gone, and native icon state is default", actual: { brandLogoUrl: config.body.brandLogoUrl ?? null, brandIconUrl: config.body.brandIconUrl ?? null, iconState } });
          },
          screenshot: {
            name: "frame-8-default-branding-restored",
            requireText: ["Search sessions"],
          },
        });
      },
    },
  ],
};
