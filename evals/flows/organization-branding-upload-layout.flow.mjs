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
  waitForDesktopConfig,
  waitForPanel,
  waitUntil,
} from "./desktop-brand-icon.flow.mjs";

const vo = await loadVoiceoverParagraphs("organization-branding-upload-layout");
const LONG_FILENAME = `example-corp-${"long-wordmark-name-".repeat(9)}final.png`;

let adminPanelTargetId = null;
let savedAssets = null;
let brandShapeStates = [];

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

async function readAssets(ctx) {
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
    body: JSON.stringify({ name: "Example Corp", brandAppName: "Example Work", brandLogoUrl: null, brandIconUrl: null }),
  });

  await ctx.control("eval.auth.set-base-url", { baseUrl: process.env.OPENWORK_EVAL_DEN_WEB_URL });
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

async function navigateBrandSettings(ctx) {
  await panelEval(ctx, `location.replace(${JSON.stringify(orgSettingsUrl(ctx))})`).catch(() => undefined);
  await waitForPanel(ctx, `document.body.innerText.includes('Brand appearance') && document.body.innerText.includes('Wordmark')`, {
    timeoutMs: 60_000,
    label: "Brand appearance settings",
  });
}

async function selectAsset(ctx, kind, { filename, width, height }) {
  return panelEval(ctx, `(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = ${width};
    canvas.height = ${height};
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = ${JSON.stringify(kind === "logo" ? "#123f73" : "#0f766e")};
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = 'bold 48px sans-serif';
    context.fillText(${JSON.stringify(kind === "logo" ? "EXAMPLE CORP" : "EX")}, canvas.width / 2, canvas.height / 2);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png'));
    const file = new File([blob], ${JSON.stringify(filename)}, { type: 'image/png' });
    const input = document.querySelector(${JSON.stringify(`#brand-${kind}-upload`)});
    if (!(input instanceof HTMLInputElement)) throw new Error('File input unavailable');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { name: file.name, width: canvas.width, height: canvas.height };
  })()`, { awaitPromise: true });
}

async function layoutState(ctx) {
  return panelEval(ctx, `(() => {
    const field = document.querySelector('[data-testid="brand-logo-asset-field"]');
    const preview = document.querySelector('[data-testid="brand-logo-preview"]');
    const save = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Save brand appearance');
    const rect = field?.getBoundingClientRect();
    const previewRect = preview?.getBoundingClientRect();
    const saveRect = save?.getBoundingClientRect();
    return {
      viewportWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      fieldLeft: rect?.left ?? null,
      fieldRight: rect?.right ?? null,
      previewRight: previewRect?.right ?? null,
      saveLeft: saveRect?.left ?? null,
      saveRight: saveRect?.right ?? null,
      zoom: getComputedStyle(document.body).zoom || '1',
    };
  })()`);
}

function assertContained(ctx, state, label) {
  ctx.assert(state.scrollWidth <= state.viewportWidth + 1, `${label} horizontally overflowed: ${JSON.stringify(state)}`);
  ctx.assert(state.fieldLeft >= 0 && state.fieldRight <= state.viewportWidth + 1, `${label} card escaped viewport: ${JSON.stringify(state)}`);
  ctx.assert(state.previewRight <= state.fieldRight + 1, `${label} preview escaped card: ${JSON.stringify(state)}`);
  ctx.assert(state.saveLeft >= 0 && state.saveRight <= state.viewportWidth + 1, `${label} Save action escaped viewport: ${JSON.stringify(state)}`);
}

export default {
  id: "organization-branding-upload-layout",
  title: "Branding uploads stay contained and desktop wordmarks align without adjacent text",
  kind: "user-facing",
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
        await openAdminPanel(ctx);
        await adminEnsureFreshAuth(ctx);
        await navigateBrandSettings(ctx);
        adminPanelTargetId = await getPanelTargetId(ctx);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Brand Appearance opens at a desktop viewport with its controls inside the page", {
          voiceover: vo[0],
          action: async () => {
            await panelEval(ctx, `(() => { document.body.style.zoom = '1'; document.querySelector('[data-testid="brand-logo-asset-field"]')?.scrollIntoView({ block: 'center' }); return true; })()`);
            await sleep(400);
          },
          assert: async () => {
            const state = await layoutState(ctx);
            ctx.assert(state.scrollWidth <= state.viewportWidth + 1, `Settings page overflowed before selection: ${JSON.stringify(state)}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Brand settings fit the desktop viewport before selection", actual: state });
          },
          screenshot: { name: "frame-1-brand-settings", sandboxCapture: true, targetId: adminPanelTargetId, textTargetId: adminPanelTargetId, requireText: ["Brand appearance", "Wordmark", "Save brand appearance"] },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("A long selected filename and preview stay contained without horizontal reflow", {
          voiceover: vo[1],
          action: async () => {
            await selectAsset(ctx, "logo", { filename: LONG_FILENAME, width: 640, height: 160 });
            await selectAsset(ctx, "icon", { filename: "example-corp-square-icon.png", width: 256, height: 256 });
            await waitForPanel(ctx, `document.querySelector('[data-testid="brand-logo-status"]')?.textContent?.includes('Ready to upload')`, { timeoutMs: 15_000, label: "long wordmark filename preview" });
            await panelEval(ctx, `(() => { document.querySelector('[data-testid="brand-logo-asset-field"]')?.scrollIntoView({ block: 'center' }); return true; })()`);
            await sleep(400);
          },
          assert: async () => {
            const state = await layoutState(ctx);
            assertContained(ctx, state, "Selected long filename");
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Long selected filename wraps without widening the editor", actual: { filenameLength: LONG_FILENAME.length, ...state } });
          },
          screenshot: { name: "frame-2-contained-long-filename", sandboxCapture: true, targetId: adminPanelTargetId, textTargetId: adminPanelTargetId, requireText: ["Ready to upload", "Replace image", "Save brand appearance"] },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Invalid image feedback appears without widening the settings page", {
          voiceover: vo[2],
          action: async () => {
            await selectAsset(ctx, "icon", { filename: `${"invalid-wide-icon-".repeat(8)}.png`, width: 640, height: 160 });
            await waitForPanel(ctx, `document.body.innerText.includes('Use a square image for the app icon.')`, { timeoutMs: 15_000, label: "invalid icon feedback" });
            await panelEval(ctx, `(() => { document.querySelector('[data-testid="brand-asset-error"]')?.scrollIntoView({ block: 'center' }); return true; })()`);
            await sleep(400);
          },
          assert: async () => {
            const state = await layoutState(ctx);
            assertContained(ctx, state, "Validation feedback");
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Validation feedback leaves the editor and Save action contained", actual: state });
          },
          screenshot: { name: "frame-3-validation-contained", sandboxCapture: true, targetId: adminPanelTargetId, textTargetId: adminPanelTargetId, requireText: ["Use a square image for the app icon.", "Save brand appearance"] },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The preview and Save action remain reachable at 100% and 90% zoom", {
          voiceover: vo[3],
          action: async () => {
            await selectAsset(ctx, "icon", { filename: "example-corp-square-icon.png", width: 256, height: 256 });
            await waitForPanel(ctx, `document.querySelector('[data-testid="brand-icon-status"]')?.textContent?.includes('Ready to upload')`, { timeoutMs: 15_000, label: "valid icon restored" });
          },
          assert: async () => {
            const states = [];
            for (const zoom of ["1", "0.9"]) {
              await panelEval(ctx, `(() => { document.body.style.zoom = ${JSON.stringify(zoom)}; return true; })()`);
              await sleep(250);
              const state = await layoutState(ctx);
              assertContained(ctx, state, `${Number(zoom) * 100}% zoom`);
              states.push(state);
            }
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Editor, preview, and Save action remain horizontally contained at 100% and 90%", actual: states });
          },
          screenshot: { name: "frame-4-common-zoom", sandboxCapture: true, targetId: adminPanelTargetId, textTargetId: adminPanelTargetId, requireText: ["Ready to upload", "Save brand appearance"] },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("The saved desktop header displays the uploaded wordmark without adjacent application text", {
          voiceover: vo[4],
          action: async () => {
            await panelEval(ctx, `(() => { document.body.style.zoom = '1'; return true; })()`);
            await clickSaveSettings(ctx);
            savedAssets = await waitUntil(ctx, "saved branding assets", async () => {
              const assets = await readAssets(ctx);
              return assets.logo?.version && assets.icon?.version ? assets : null;
            }, { timeoutMs: 30_000, intervalMs: 750 });
            await memberRefresh(ctx);
            await waitForDesktopConfig(ctx, "saved wordmark", (config) => config.brandLogoUrl === savedAssets.logoUrl);
            await ctx.waitFor(`(() => { const image = document.querySelector('[data-testid="brand-logo"] img'); return Boolean(image?.complete && image.naturalWidth > 0); })()`, { timeoutMs: 30_000, label: "desktop wordmark" });
          },
          assert: async () => {
            const state = await ctx.eval(`(() => ({
              image: Boolean(document.querySelector('[data-testid="brand-logo"] img')),
              adjacentName: Boolean(document.querySelector('[data-testid="brand-logo"] [data-testid="brand-app-name"]')),
              headerText: document.querySelector('[data-testid="brand-logo"]')?.textContent?.trim() ?? '',
            }))()`);
            ctx.assert(state.image, `Saved wordmark image is missing: ${JSON.stringify(state)}`);
            ctx.assert(!state.adjacentName && state.headerText === "", `Application text appeared beside the wordmark: ${JSON.stringify(state)}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Uploaded wordmark is the only branding content in the desktop header", actual: state });
          },
          screenshot: { name: "frame-5-wordmark-only", requireText: ["Search sessions"], rejectText: ["Example Work"] },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("Wide, square, and absent wordmarks keep a stable aligned desktop header", {
          voiceover: vo[5],
          action: async () => {
            brandShapeStates = [];
            for (const logoUrl of [savedAssets.logoUrl, savedAssets.iconUrl, null]) {
              await denFetch(ctx, "/v1/org", { method: "PATCH", body: JSON.stringify({ brandLogoUrl: logoUrl }) });
              await memberRefresh(ctx);
              await waitForDesktopConfig(ctx, "wordmark shape", (config) => (config.brandLogoUrl ?? null) === logoUrl);
              if (logoUrl) {
                await ctx.waitFor(`(() => { const image = document.querySelector('[data-testid="brand-logo"] img'); return image?.src === ${JSON.stringify(logoUrl)} && image.complete && image.naturalWidth > 0; })()`, { timeoutMs: 20_000, label: "shape wordmark" });
              } else {
                await ctx.waitFor(`Boolean(document.querySelector('[data-testid="brand-logo"] [data-testid="brand-app-name"]')) && !document.querySelector('[data-testid="brand-logo"] img')`, { timeoutMs: 20_000, label: "wordmark name fallback" });
              }
              const state = await ctx.eval(`(() => {
                const header = document.querySelector('[data-testid="brand-logo"]');
                const image = header?.querySelector('img');
                const rect = header?.getBoundingClientRect();
                return { logoUrl: ${JSON.stringify(logoUrl)}, height: rect?.height ?? 0, left: rect?.left ?? 0, imageWidth: image?.getBoundingClientRect().width ?? 0, imageHeight: image?.getBoundingClientRect().height ?? 0, fallback: Boolean(header?.querySelector('[data-testid="brand-app-name"]')) };
              })()`);
              brandShapeStates.push(state);
            }
            await sleep(1_500);
          },
          assert: async () => {
            const states = brandShapeStates;
            ctx.assert(states.length === 3, `Expected wide, square, and absent states: ${JSON.stringify(states)}`);
            for (const state of states) {
              ctx.assert(state.height === 56 && state.left === 0, `Header alignment changed: ${JSON.stringify(state)}`);
              ctx.assert(state.imageHeight <= 36 && state.imageWidth <= 140, `Wordmark escaped its bounds: ${JSON.stringify(state)}`);
            }
            ctx.assert(states[2].fallback, `Absent wordmark did not use the name fallback: ${JSON.stringify(states[2])}`);
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Wide, square, and absent brand states share the same 56px left-aligned header chrome", actual: states });
          },
          screenshot: { name: "frame-6-aligned-fallback", requireText: ["Example Work", "Search sessions"] },
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        await ctx.prove("Returning to Brand Appearance shows the saved image without editor overflow", {
          voiceover: vo[6],
          action: async () => {
            await denFetch(ctx, "/v1/org", { method: "PATCH", body: JSON.stringify({ brandLogoUrl: savedAssets.logoUrl }) });
            await openAdminPanel(ctx);
            await adminEnsureFreshAuth(ctx);
            await navigateBrandSettings(ctx);
            adminPanelTargetId = await getPanelTargetId(ctx);
            await waitForPanel(ctx, `(() => { const image = document.querySelector('[data-testid="brand-logo-preview"]'); const status = document.querySelector('[data-testid="brand-logo-status"]')?.textContent ?? ''; return image?.complete && image.naturalWidth > 0 && (status.includes('Stored in this Den') || status.includes('Current hosted image')); })()`, { timeoutMs: 30_000, label: "saved image after return" });
            await panelEval(ctx, `(() => { document.querySelector('[data-testid="brand-logo-asset-field"]')?.scrollIntoView({ block: 'center' }); return true; })()`);
            await sleep(400);
          },
          assert: async () => {
            const state = await layoutState(ctx);
            assertContained(ctx, state, "Returned editor");
            ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Saved wordmark remains visible and the returned editor has no horizontal overflow", actual: state });
          },
          screenshot: { name: "frame-7-saved-editor-contained", sandboxCapture: true, targetId: adminPanelTargetId, textTargetId: adminPanelTargetId, requireText: ["Brand appearance", "Save brand appearance"] },
        });
      },
    },
  ],
};
