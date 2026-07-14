import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "keyless-den-connect";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const DEN_API_URL = clean(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = clean(process.env.OPENWORK_EVAL_DEN_WEB_URL);
const WEB_CDP_URL = clean(process.env.OPENWORK_EVAL_WEB_CDP_ADMIN);
const DEN_TOKEN = process.env.OPENWORK_EVAL_DEN_TOKEN?.trim() || "";
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BRANDED_APP_NAME = "Acme Work";
const BRAND_LOGO_URL = `${DEN_WEB_URL}/openwork-logo-transparent.svg`;

const state = {
  desktopClient: null,
  installToken: "",
  installPageUrl: "",
  connectUrl: "",
  organizationName: "",
  serverHost: "",
  configuredDownloadUrl: "",
};

function clean(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

function rememberDesktop(ctx) {
  if (!state.desktopClient) state.desktopClient = ctx.client;
}

function useDesktop(ctx) {
  if (!state.desktopClient) throw new Error("Desktop CDP client was not captured.");
  ctx.client = state.desktopClient;
}

async function firstPageTarget(cdpBaseUrl) {
  const existing = await listTargets(cdpBaseUrl);
  const page = existing.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (page) return page;
  const response = await fetch(`${cdpBaseUrl}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) throw new Error(`Could not create Den browser target: ${response.status}`);
  return response.json();
}

async function withWeb(ctx, fn) {
  const previous = ctx.client;
  const target = await firstPageTarget(WEB_CDP_URL);
  const client = await connect(debuggerUrlFor(WEB_CDP_URL, target));
  ctx.client = client;
  try {
    return await fn();
  } finally {
    ctx.client = previous;
    client.close();
  }
}

async function navigate(ctx, target) {
  const url = new URL(target, DEN_WEB_URL).toString();
  await ctx.eval(`location.assign(${JSON.stringify(url)}); true`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${target}` });
}

async function clickExact(ctx, text, selector = "button, a") {
  await ctx.waitFor(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((entry) => (entry.textContent ?? '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)} && !entry.disabled);
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click ${text}` });
}

async function clickWithoutFollowing(ctx, selector) {
  await ctx.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.addEventListener('click', (event) => event.preventDefault(), { once: true });
    element.click();
    return true;
  })()`);
}

async function signIn(ctx) {
  await navigate(ctx, "/");
  if (await ctx.eval("location.pathname.startsWith('/dashboard')")) return;
  if (await ctx.eval("!document.querySelector('input[type=email]') && document.body.innerText.includes('Sign in')")) {
    await clickExact(ctx, "Sign in");
  }
  await ctx.waitFor("Boolean(document.querySelector('input[type=email]'))", { timeoutMs: 30_000, label: "Den email input" });
  await ctx.fill('input[type="email"]', ADMIN_EMAIL);
  const hasNext = await ctx.eval("[...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Next')");
  if (hasNext) await clickExact(ctx, "Next", "button");
  await ctx.waitFor("Boolean(document.querySelector('input[type=password]'))", { timeoutMs: 20_000, label: "Den password input" });
  await ctx.fill('input[type="password"]', ADMIN_PASSWORD);
  await clickExact(ctx, "Sign in", "button");
  await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 45_000, label: "Den dashboard" });
}

async function denApi(pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${DEN_TOKEN}`);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`${DEN_API_URL}${pathname}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

async function configureBrand(ctx) {
  const updated = await denApi("/v1/org", {
    method: "PATCH",
    body: JSON.stringify({ brandAppName: BRANDED_APP_NAME, brandLogoUrl: BRAND_LOGO_URL }),
  });
  witness(ctx, updated.response.ok, "The demo organization exposes its configured name and wordmark", {
    status: updated.response.status,
    appName: BRANDED_APP_NAME,
    logoUrl: BRAND_LOGO_URL,
  });
}

async function restoreBrand() {
  await denApi("/v1/org", {
    method: "PATCH",
    body: JSON.stringify({ brandAppName: null, brandLogoUrl: null }),
  }).catch(() => null);
}

async function openGuideFromDashboard(ctx) {
  await configureBrand(ctx);
  await signIn(ctx);
  await navigate(ctx, "/dashboard");
  await ctx.waitFor("Boolean(document.querySelector('[data-testid=organization-download-button]'))", { timeoutMs: 30_000, label: "workspace download" });
  await clickExact(ctx, "Download for this workspace", "button");
  await ctx.waitFor("location.pathname === '/install'", { timeoutMs: 30_000, label: "install navigation" });
  const navigated = new URL(await ctx.eval("location.href"));
  state.installToken = navigated.searchParams.get("token") ?? "";
  state.installPageUrl = new URL(`/install?token=${encodeURIComponent(state.installToken)}`, DEN_WEB_URL).toString();
  await ctx.eval(`location.assign(${JSON.stringify(state.installPageUrl)}); true`);
  await ctx.waitFor("Boolean(document.querySelector('[data-testid=install-guide]'))", { timeoutMs: 30_000, label: "guided installer" });
}

async function deliverDeepLinkToDesktop(ctx, openworkUrl) {
  await ctx.eval(`(() => {
    const url = ${JSON.stringify(openworkUrl)};
    window.__OPENWORK__ = window.__OPENWORK__ || {};
    const pending = window.__OPENWORK__.deepLinks || [];
    window.__OPENWORK__.deepLinks = [...pending, url];
    window.dispatchEvent(new CustomEvent('openwork:deep-link', { detail: { urls: [url] } }));
    return true;
  })()`);
}

async function resetDesktopSession(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop ready" });
  await ctx.eval(`(() => {
    document.querySelector('[data-testid=connect-confirm-cancel]')?.click();
    document.querySelector('[data-testid=connect-error-dismiss]')?.click();
    for (const key of [
      'openwork.den.authToken',
      'openwork.den.activeOrgId',
      'openwork.den.activeOrgSlug',
      'openwork.den.activeOrgName',
    ]) localStorage.removeItem(key);
    window.dispatchEvent(new CustomEvent('openwork-den-session-updated', { detail: { status: 'signed_out' } }));
    return true;
  })()`);
}

function tamperExchangeUrl(rawUrl) {
  const url = new URL(rawUrl);
  const code = url.searchParams.get("code") ?? "";
  const last = code.at(-1);
  url.searchParams.set("code", `${code.slice(0, -1)}${last === "a" ? "b" : "a"}`);
  return url.toString();
}

export default {
  id: FLOW_ID,
  title: "A Den user installs and connects the standard app without deployment keys",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_WEB_CDP_ADMIN",
  ],
  steps: [
    {
      name: "Organization setup is explicit",
      run: async (ctx) => {
        rememberDesktop(ctx);
        useDesktop(ctx);
        await resetDesktopSession(ctx);
        await withWeb(ctx, async () => ctx.prove("The Den organization download opens one explicit three-step setup", {
          voiceover: vo[0],
          action: async () => openGuideFromDashboard(ctx),
          assert: async () => {
            state.organizationName = await ctx.eval(`(() => {
              const heading = document.querySelector('[data-testid=install-card] h1')?.textContent?.trim() ?? '';
              return heading.includes(' for ') ? heading.split(' for ').at(-1) ?? '' : '';
            })()`);
            witness(ctx, Boolean(state.installToken), "The page came from a real organization install token", "token redacted");
            witness(ctx, state.organizationName === "Acme Robotics", "The guide identifies the exact organization", state.organizationName);
            await ctx.expectText("Download and install");
            await ctx.expectText(`Open ${BRANDED_APP_NAME}`);
            await ctx.expectText("Sign in");
            await ctx.expectNoText("OpenWork Enterprise");
          },
          screenshot: {
            name: "keyless-three-step-guide",
            requireText: ["Download and install", `Open ${BRANDED_APP_NAME}`, "Sign in", "Acme Robotics"],
            rejectText: ["OpenWork Enterprise"],
          },
        }));
      },
    },
    {
      name: "Standard installer starts directly",
      run: async (ctx) => withWeb(ctx, async () => ctx.prove("Download redirects immediately to the standard release without a custom ZIP", {
        voiceover: vo[1],
        action: async () => {
          await navigate(ctx, state.installPageUrl);
          await ctx.waitFor("Boolean(document.querySelector('[data-testid=install-download-primary]'))", { timeoutMs: 30_000, label: "download action" });
          const href = await ctx.eval("document.querySelector('[data-testid=install-download-primary]')?.href ?? ''");
          const started = performance.now();
          const first = await fetch(href, { redirect: "manual" });
          const firstMs = Math.round(performance.now() - started);
          const repeatedStarted = performance.now();
          const repeated = await fetch(href, { redirect: "manual" });
          const repeatedMs = Math.round(performance.now() - repeatedStarted);
          const location = first.headers.get("location") ?? "";
          state.configuredDownloadUrl = location;
          witness(ctx, first.status === 302 && repeated.status === 302, "First and repeated downloads both use the immediate redirect path", {
            first: { status: first.status, elapsedMs: firstMs },
            repeated: { status: repeated.status, elapsedMs: repeatedMs },
          });
          witness(ctx, location.includes("github.com/different-ai/openwork/releases/download/"), "The redirect targets the configured standard GitHub release", location);
          witness(ctx, !location.includes(state.installToken), "The organization token is never forwarded to GitHub", location);
          ctx.output("direct standard installer", JSON.stringify({ href, location, firstMs, repeatedMs }, null, 2));
          await clickWithoutFollowing(ctx, "[data-testid=install-download-primary]");
        },
        assert: async () => {
          witness(ctx, (await ctx.eval("document.querySelector('[data-testid=install-guide-step-download]')?.dataset.state")) === "complete", "The page advances immediately instead of showing a server preparation wait", "complete");
          await ctx.expectNoText("Preparing your");
          await ctx.expectNoText("ZIP");
          await ctx.expectText("When installation finishes, return to this page.");
        },
        screenshot: {
          name: "standard-installer-no-wait",
          requireText: ["Download again", `Open ${BRANDED_APP_NAME}`, "return to this page"],
          rejectText: ["Preparing your", "ZIP"],
        },
      })),
    },
    {
      name: "Fresh keyless link previews the target",
      run: async (ctx) => {
        await withWeb(ctx, async () => {
          await navigate(ctx, `${state.installPageUrl}&step=2`);
          await ctx.waitFor("Boolean(document.querySelector('[data-testid=install-connect-open]'))", { timeoutMs: 30_000, label: "open app action" });
          const initialResponse = await fetch(`${DEN_API_URL}/v1/install-config?token=${encodeURIComponent(state.installToken)}`);
          const initialConfig = await initialResponse.json();
          await ctx.eval(`(() => {
            const originalFetch = window.fetch.bind(window);
            window.__keylessConnectCapture = null;
            window.fetch = async (...args) => {
              const response = await originalFetch(...args);
              const input = args[0];
              const requestUrl = typeof input === 'string' ? input : input?.url ?? String(input);
              if (requestUrl.includes('/v1/install-config')) {
                try {
                  const payload = await response.clone().json();
                  window.__keylessConnectCapture = payload;
                } catch {}
              }
              return response;
            };
            return true;
          })()`);
          await clickExact(ctx, `Open ${BRANDED_APP_NAME}`, "button");
          await ctx.waitFor("Boolean(window.__keylessConnectCapture?.connectUrl)", { timeoutMs: 20_000, label: "fresh click-time connection link" });
          state.connectUrl = await ctx.eval("window.__keylessConnectCapture.connectUrl");
          const connect = new URL(state.connectUrl);
          state.serverHost = new URL(connect.searchParams.get("apiBaseUrl") ?? "http://invalid").host;
          witness(ctx, connect.protocol === "openwork:" && Boolean(connect.searchParams.get("code")) && !connect.searchParams.has("token"), "The default handoff is a keyless short-lived exchange", state.connectUrl.replace(connect.searchParams.get("code") ?? "", "<redacted>"));
          witness(ctx, initialConfig.connectUrl !== state.connectUrl, "Clicking Open mints a fresh link after the installer wait", {
            initial: "redacted",
            clickTime: "redacted",
          });
        });

        useDesktop(ctx);
        await ctx.prove("Open Work shows the exact organization and Den server before changing anything", {
          voiceover: vo[2],
          action: async () => {
            await resetDesktopSession(ctx);
            if (!(await ctx.eval("Boolean(document.querySelector('[data-testid=connect-confirm-dialog]'))"))) {
              await deliverDeepLinkToDesktop(ctx, state.connectUrl);
            }
          },
          assert: async () => {
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=connect-confirm-dialog]'))", { timeoutMs: 30_000, label: "connection confirmation" });
            await ctx.expectText("Acme Robotics");
            await ctx.expectText(state.serverHost);
            await ctx.expectText("Nothing has been changed yet.");
          },
          screenshot: {
            name: "keyless-exact-target-confirmation",
            requireText: ["Acme Robotics", "Server", state.serverHost, "Nothing has been changed yet", "Connect"],
          },
        });
      },
    },
    {
      name: "Confirmation applies branding and sign-in",
      run: async (ctx) => {
        useDesktop(ctx);
        await ctx.prove("Confirmation applies the organization wordmark and opens normal sign-in", {
          voiceover: vo[3],
          action: async () => clickExact(ctx, "Connect", "button"),
          assert: async () => {
            await ctx.waitForText(`Welcome to ${BRANDED_APP_NAME}`, { timeoutMs: 45_000 });
            await ctx.expectText(`Sign in to ${BRANDED_APP_NAME}`);
            const persisted = await ctx.eval("window.__OPENWORK_ELECTRON__.invokeDesktop('getDesktopBootstrapConfig')", { awaitPromise: true });
            witness(ctx, persisted?.brandAppName === BRANDED_APP_NAME && persisted?.brandLogoUrl === BRAND_LOGO_URL && persisted?.requireSignin === true, "The accepted handoff persisted the organization name, wordmark, and normal sign-in gate", persisted);
            witness(ctx, await ctx.eval(`document.querySelector('img[alt=${JSON.stringify(`${BRANDED_APP_NAME} logo`)}]')?.src === ${JSON.stringify(BRAND_LOGO_URL)}`), "The sign-in screen renders the configured organization wordmark", BRAND_LOGO_URL);
          },
          screenshot: {
            name: "branded-normal-signin",
            requireText: [`Welcome to ${BRANDED_APP_NAME}`, `Sign in to ${BRANDED_APP_NAME}`, "workspace"],
          },
        });
      },
    },
    {
      name: "Reuse and tampering fail closed",
      run: async (ctx) => {
        useDesktop(ctx);
        await ctx.prove("A reused or altered exchange is refused and leaves desktop configuration untouched", {
          voiceover: vo[4],
          action: async () => {
            const before = await ctx.eval("window.__OPENWORK_ELECTRON__.invokeDesktop('getDesktopBootstrapConfig')", { awaitPromise: true });
            const exchange = new URL(state.connectUrl);
            const apiBaseUrl = exchange.searchParams.get("apiBaseUrl") ?? "";
            const code = exchange.searchParams.get("code") ?? "";
            const replay = await fetch(`${apiBaseUrl}/v1/install-connect/exchange`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ code }),
            });
            witness(ctx, replay.status === 409, "The server refuses a second use of the consumed code", replay.status);
            await deliverDeepLinkToDesktop(ctx, tamperExchangeUrl(state.connectUrl));
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=connect-error-message]'))", { timeoutMs: 30_000, label: "tampered link refusal" });
            const after = await ctx.eval("window.__OPENWORK_ELECTRON__.invokeDesktop('getDesktopBootstrapConfig')", { awaitPromise: true });
            witness(ctx, JSON.stringify(after) === JSON.stringify(before), "Refusal leaves every persisted desktop setting untouched", { before, after });
          },
          assert: async () => {
            await ctx.expectText("This link can't be used");
            await ctx.expectText("Nothing about this app was changed.");
          },
          screenshot: {
            name: "tampered-link-refused",
            requireText: ["This link can't be used", "Nothing about this app was changed", "Close"],
          },
        });
      },
    },
    {
      name: "Signed mode keeps the same installer",
      run: async (ctx) => {
        try {
          await withWeb(ctx, async () => ctx.prove("Optional signed handoffs use the same standard installer experience", {
            voiceover: vo[5],
            action: async () => {
              const defaultRender = spawnSync("helm", ["template", "openwork-ee", "packaging/helm/openwork-ee"], {
                cwd: REPO_ROOT,
                encoding: "utf8",
              });
              const signedRender = spawnSync("helm", [
                "template", "openwork-ee", "packaging/helm/openwork-ee",
                "--set", "config.public.connectLinkMode=signed",
                "--set", "config.public.connectLinkKeyId=owc-future",
                "--set-string", "secret.values.connectLinkPrivateKey=future-private-key",
              ], { cwd: REPO_ROOT, encoding: "utf8" });
              witness(ctx, defaultRender.status === 0 && defaultRender.stdout.includes('DEN_CONNECT_LINK_MODE: "exchange"'), "The chart defaults every custom deployment to no-key exchange mode", defaultRender.status);
              witness(ctx, signedRender.status === 0 && signedRender.stdout.includes('DEN_CONNECT_LINK_MODE: "signed"'), "An operator has an explicit signed-mode upgrade path", signedRender.status);

              await navigate(ctx, state.installPageUrl);
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=install-download-primary]'))", { timeoutMs: 30_000, label: "unchanged standard download" });
              const href = await ctx.eval("document.querySelector('[data-testid=install-download-primary]')?.href ?? ''");
              const response = await fetch(href, { redirect: "manual" });
              witness(ctx, response.status === 302 && response.headers.get("location") === state.configuredDownloadUrl, "Handoff mode does not create or select a different installer", {
                status: response.status,
                location: response.headers.get("location"),
              });
              ctx.output("Helm handoff modes", [
                'default: DEN_CONNECT_LINK_MODE: "exchange"',
                'optional: DEN_CONNECT_LINK_MODE: "signed"',
                `installer: ${response.headers.get("location")}`,
              ].join("\n"));
            },
            assert: async () => {
              await ctx.expectText("Download and install");
              await ctx.expectText(`Open ${BRANDED_APP_NAME}`);
              await ctx.expectNoText("custom installer");
              await ctx.expectNoText("OpenWork Enterprise");
            },
            screenshot: {
              name: "same-installer-future-signed-mode",
              requireText: ["Download and install", `Open ${BRANDED_APP_NAME}`, "Run the normal signed installer"],
              rejectText: ["custom installer", "OpenWork Enterprise"],
            },
          }));
        } finally {
          await restoreBrand();
        }
      },
    },
  ],
};
