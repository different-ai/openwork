import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/dont-promote-ow-models-in-non-default-apps.md).
// The runner fails this flow if the narration drifts from that script.
const FLOW_ID = "dont-promote-ow-models-in-non-default-apps";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEFAULT_DEN_BASE_URL = "https://app.openworklabs.com";
const DEFAULT_DEN_API_BASE_URL = "https://app.openworklabs.com/api/den";
const CUSTOM_TOKEN = "custom-den-eval-token";
const CUSTOM_ORG = { id: "org_custom_den_eval", slug: "custom-den-eval", name: "Custom Den Eval Org", role: "owner" };
const CUSTOM_USER = { id: "usr_custom_den_eval", email: "owner@custom-den-eval.test", name: "Custom Den Eval Owner" };
const CUSTOM_PROVIDER = {
  id: "lpr_custom_den_eval",
  source: "custom",
  providerId: "openai-compatible",
  name: "Acme Managed Models",
  providerConfig: {
    npm: "@ai-sdk/openai-compatible",
    api: "http://127.0.0.1:9/v1",
    env: ["ACME_MODELS_API_KEY"],
  },
  hasApiKey: true,
  models: [
    { id: "acme-large", name: "Acme Large", config: {}, createdAt: "2026-07-15T00:00:00.000Z" },
  ],
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
};
const PROMO_REJECT_TEXT = [
  "Use OpenWork Models",
  "Use OpenWork Models without API keys",
  "Continue without OpenWork Models",
  "Sign in to unlock hosted frontier models",
  "Subscribe to use hosted frontier models",
  "Subscribe to add this model",
];

const state = {
  workspaceDir: "",
  workspaceId: "",
  sessionId: "",
  customDen: null,
  serverAuth: null,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quoted = (value) => JSON.stringify(value);

function prefsPatchScript(patch) {
  return `(() => {
    let prefs = {};
    try {
      const raw = localStorage.getItem("openwork.preferences");
      prefs = raw ? JSON.parse(raw) : {};
    } catch {
      prefs = {};
    }
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) prefs = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({ ...prefs, ...${JSON.stringify(patch)} }));
    return true;
  })()`;
}

function promoResetScript() {
  return `(() => {
    for (const key of [
      "openwork.openworkModelsPromo.hidden",
      "openwork.openworkModelsPromo.lastShownAt",
      "openwork.openworkModelsPromo.startupShown",
    ]) {
      localStorage.removeItem(key);
    }
    window.dispatchEvent(new Event("openwork-openwork-models-promo-changed"));
    return true;
  })()`;
}

function shellDefaultsScript() {
  return `(() => {
    let shellConfig = {};
    try {
      const raw = localStorage.getItem("openwork.shell-config");
      shellConfig = raw ? JSON.parse(raw) : {};
    } catch {
      shellConfig = {};
    }
    localStorage.setItem("openwork.shell-config", JSON.stringify({
      ...shellConfig,
      addWorkspace: true,
      cloudSignin: true,
      modelPicker: true,
      sidebar: true,
      statusBar: true,
      welcomePage: true,
    }));
    return true;
  })()`;
}

function clearDenSessionScript() {
  return `(() => {
    for (const key of [
      "openwork.den.authToken",
      "openwork.den.activeOrgId",
      "openwork.den.activeOrgSlug",
      "openwork.den.activeOrgName",
      "openwork.den.mcp.sync",
    ]) {
      localStorage.removeItem(key);
    }
    return true;
  })()`;
}

async function findFreePort() {
  const server = createServer();
  server.unref();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  server.close();
  if (!address || typeof address === "string") throw new Error("Could not allocate a free port for the custom Den fixture.");
  return address.port;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "access-control-allow-headers": "authorization, content-type, x-openwork-legacy-org-id",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "*",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

function customProviderConnection() {
  return {
    ...CUSTOM_PROVIDER,
    apiKey: "sk-custom-den-eval",
    apiKeys: null,
  };
}

async function startCustomDenServer() {
  const requests = [];
  let baseUrl = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", baseUrl || "http://127.0.0.1");
    const denPath = url.pathname.replace(/^\/api\/den(?=\/|$)/, "") || "/";
    requests.push({ method: request.method, path: denPath, authorization: request.headers.authorization ?? null });

    if (request.method === "OPTIONS") {
      sendJson(response, 204, {});
      return;
    }

    if (denPath === "/v1/me" && request.method === "GET") {
      sendJson(response, 200, { user: CUSTOM_USER });
      return;
    }
    if (denPath === "/v1/me/orgs" && request.method === "GET") {
      sendJson(response, 200, { orgs: [CUSTOM_ORG], activeOrgId: CUSTOM_ORG.id, activeOrgSlug: CUSTOM_ORG.slug });
      return;
    }
    if (denPath === "/v1/me/active-organization" && request.method === "POST") {
      sendJson(response, 200, { activeOrgId: CUSTOM_ORG.id, activeOrgSlug: CUSTOM_ORG.slug });
      return;
    }
    if (denPath === "/v1/me/desktop-config" && request.method === "GET") {
      sendJson(response, 200, {});
      return;
    }
    if (denPath === "/v1/resources" && request.method === "GET") {
      sendJson(response, 200, {
        organizationId: CUSTOM_ORG.id,
        orgMemberId: "mem_custom_den_eval",
        teamIds: [],
        resources: {
          llmProviders: { [CUSTOM_PROVIDER.id]: CUSTOM_PROVIDER.updatedAt },
          marketplaces: {},
        },
      });
      return;
    }
    if (denPath === "/v1/llm-providers" && request.method === "GET") {
      sendJson(response, 200, { llmProviders: [CUSTOM_PROVIDER] });
      return;
    }
    if (denPath === `/v1/llm-providers/${encodeURIComponent(CUSTOM_PROVIDER.id)}/connect` && request.method === "GET") {
      sendJson(response, 200, { llmProvider: customProviderConnection() });
      return;
    }
    if (denPath === "/v1/mcp/token" && request.method === "POST") {
      sendJson(response, 200, {
        token: "mcp_custom_den_eval",
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        organizationId: CUSTOM_ORG.id,
        scopes: ["mcp:read", "mcp:write"],
        resource: `${baseUrl}/api/den/mcp/agent`,
      });
      return;
    }
    if (denPath.startsWith("/v1/mcp-connections") && request.method === "GET") {
      sendJson(response, 200, { connections: [] });
      return;
    }
    if (denPath === "/v1/app-version" && request.method === "GET") {
      sendJson(response, 200, {
        minAppVersion: "0.0.0",
        latestAppVersion: "0.0.0",
        publishedDesktopVersions: ["0.0.0"],
      });
      return;
    }

    sendJson(response, 404, { error: "not_found", path: denPath });
  });

  const port = await findFreePort();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function waitForControl(ctx, label = "OpenWork control API") {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label });
}

async function waitForWorkspaceReady(ctx) {
  await ctx.waitFor(`(() => {
    const text = document.body.innerText;
    return !text.includes("Preparing workspace") && !text.includes("Pulling in the latest messages");
  })()`, { timeoutMs: 90_000, label: "workspace UI ready" });
}

async function closeDialogs(ctx) {
  await ctx.eval(`(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  })()`);
  await sleep(250);
}

async function setDesktopBootstrapConfig(ctx, config) {
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", {
    timeoutMs: 60_000,
    label: "desktop bridge",
  });
  await ctx.eval(`(async () => {
    const config = ${JSON.stringify(config)};
    const persisted = await window.__OPENWORK_ELECTRON__.invokeDesktop("setDesktopBootstrapConfig", config);
    const baseUrl = persisted?.baseUrl || config.baseUrl;
    const apiBaseUrl = persisted?.apiBaseUrl || config.apiBaseUrl || (baseUrl.replace(/\\/+$/, "") + "/api/den");
    localStorage.setItem("openwork.den.baseUrl", baseUrl);
    localStorage.setItem("openwork.den.apiBaseUrl", apiBaseUrl);
    return { baseUrl, apiBaseUrl };
  })()`, { awaitPromise: true });
}

async function resetToDefaultDen(ctx) {
  await closeDialogs(ctx);
  await setDesktopBootstrapConfig(ctx, {
    baseUrl: DEFAULT_DEN_BASE_URL,
    apiBaseUrl: DEFAULT_DEN_API_BASE_URL,
    requireSignin: false,
  });
  await ctx.eval(`(async () => {
    ${shellDefaultsScript()};
    ${clearDenSessionScript()};
    ${promoResetScript()};
    ${prefsPatchScript({ hasCompletedOnboarding: true, providerStepCompleted: true })};
    if (${quoted(state.workspaceId)}) {
      await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("workspaceSetSelected", ${quoted(state.workspaceId)});
      await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("workspaceSetRuntimeActive", ${quoted(state.workspaceId)});
      localStorage.setItem("openwork.react.activeWorkspace", ${quoted(state.workspaceId)});
    }
    location.hash = ${quoted(state.workspaceId ? `#/workspace/${state.workspaceId}/session` : "#/session")};
    location.reload();
    return true;
  })()`, { awaitPromise: true });
  await waitForControl(ctx, "control API after default Den reset");
  await waitForWorkspaceReady(ctx);
}

async function createDedicatedWorkspace(ctx) {
  await waitForControl(ctx);
  await ctx.waitFor(
    `(async () => {
      const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
      return Boolean(info?.running && info.port && info.clientToken);
    })()`,
    { timeoutMs: 30_000, label: "OpenWork server auth for workspace setup" },
  );
  state.workspaceDir = ctx.env.OPENWORK_EVAL_WORKSPACE_DIR?.trim() || join(tmpdir(), `${FLOW_ID}-${Date.now()}`);
  await mkdir(state.workspaceDir, { recursive: true });
  const auth = await ctx.eval(`(async () => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    return {
      port: info.port || "",
      token: info.clientToken || "",
      hostToken: info.hostToken || "",
    };
  })()`, { awaitPromise: true });
  const baseUrl = `http://127.0.0.1:${auth.port}`;
  state.serverAuth = auth;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${auth.token}`,
    ...(auth.hostToken ? { "x-openwork-host-token": auth.hostToken } : {}),
  };
  let response;
  try {
    response = await fetch(`${baseUrl}/workspaces/local`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderPath: state.workspaceDir, name: "Custom Den Promo Eval", preset: "starter" }),
    });
  } catch (error) {
    throw new Error(`Could not reach OpenWork server at ${baseUrl}: ${error?.message ?? error}`);
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  ctx.assert(response.ok, `Could not create the dedicated eval workspace: ${response.status} ${text.slice(0, 500)}`);
  const workspaces = Array.isArray(payload?.workspaces) ? payload.workspaces : Array.isArray(payload?.items) ? payload.items : [];
  const workspace = workspaces.find((entry) => entry?.path === state.workspaceDir) || workspaces[workspaces.length - 1];
  const workspaceId = payload?.selectedId || payload?.activeId || workspace?.id || "";
  ctx.assert(workspaceId, `Workspace create returned no id: ${text.slice(0, 500)}`);
  const activate = await fetch(`${baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/activate?persist=true`, { method: "POST", headers });
  ctx.assert(activate.ok, `Could not activate the dedicated eval workspace: ${activate.status} ${await activate.text()}`);
  state.workspaceId = workspaceId;
  await ctx.eval(`(async () => {
    ${shellDefaultsScript()};
    ${prefsPatchScript({ hasCompletedOnboarding: true, providerStepCompleted: true })};
    await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("workspaceSetSelected", ${quoted(workspaceId)});
    await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("workspaceSetRuntimeActive", ${quoted(workspaceId)});
    localStorage.setItem("openwork.react.activeWorkspace", ${quoted(workspaceId)});
    location.hash = ${quoted(`#/workspace/${workspaceId}/session`)};
    location.reload();
    return true;
  })()`, { awaitPromise: true });
  await waitForControl(ctx, "control API after dedicated workspace creation");
  await ctx.waitFor(`location.hash.includes(${quoted(`/workspace/${state.workspaceId}`)})`, {
    timeoutMs: 60_000,
    label: "dedicated workspace route",
  });
  state.serverAuth = auth;
}

async function ensureSession(ctx) {
  await ctx.navigateHash(`/workspace/${state.workspaceId}/session`);
  await ctx.waitFor("window.__openworkControl?.listActions?.().some((action) => action.id === 'session.create_task' && !action.disabled)", {
    timeoutMs: 90_000,
    label: "session.create_task enabled",
  });
  if (!(await ctx.eval("location.hash.includes('/session/ses_')"))) {
    await ctx.control("session.create_task");
    await ctx.waitFor("location.hash.includes('/session/ses_')", { timeoutMs: 90_000, label: "fresh session route" });
  }
  const hash = await ctx.eval("location.hash");
  state.sessionId = hash.match(/\/session\/(ses_[^/?#]+)/)?.[1] ?? state.sessionId;
}

async function openModelPicker(ctx) {
  await ctx.navigateHash(`/workspace/${state.workspaceId}/session`);
  await waitForControl(ctx);
  await waitForWorkspaceReady(ctx);
  await sleep(1_200);
  await closeDialogs(ctx);
  await ctx.waitFor("window.__openworkControl?.listActions?.().some((action) => action.id === 'session.model_picker.open' && !action.disabled)", {
    timeoutMs: 60_000,
    label: "session.model_picker.open enabled",
  });
  await ctx.control("session.model_picker.open");
  await ctx.waitForText("Models", { timeoutMs: 30_000 });
}

async function assertNoPromoText(ctx, surface) {
  const body = await ctx.eval("document.body.innerText");
  const found = PROMO_REJECT_TEXT.filter((text) => body.includes(text));
  ctx.recordEvidence({
    type: "assertion",
    status: found.length === 0 ? "passed" : "failed",
    assertion: `${surface} does not contain OpenWork Models subscribe or promo copy.`,
    actual: found,
  });
  ctx.assert(found.length === 0, `${surface} still contains promo copy: ${found.join(", ")}`);
}

function providerRowButtonExpression(label, rowText, click) {
  return `(() => {
    const buttons = [...document.querySelectorAll("button")].filter((button) => (button.textContent || "").trim() === ${quoted(label)});
    for (const button of buttons) {
      let node = button.parentElement;
      for (let depth = 0; depth < 8 && node; depth += 1, node = node.parentElement) {
        const text = node.textContent || "";
        if (text.includes(${quoted(rowText)}) && text.length < 1000) {
          button.scrollIntoView({ block: "center" });
          if (${click ? "true" : "false"}) button.click();
          return true;
        }
      }
    }
    return false;
  })()`;
}

async function clickProviderRowButton(ctx, label, rowText) {
  const clicked = await ctx.waitFor(providerRowButtonExpression(label, rowText, true), { timeoutMs: 30_000, label: `${label} button on ${rowText} row` });
  ctx.assert(clicked, `Could not click ${label} on ${rowText}.`);
}

async function hasProviderRowButton(ctx, label, rowText) {
  return Boolean(await ctx.eval(providerRowButtonExpression(label, rowText, false)));
}

async function workspaceConfigRequest(ctx, method, body) {
  const deadline = Date.now() + 30_000;
  let response = null;
  let auth = null;
  while (Date.now() < deadline) {
    auth = await ctx.eval(`(async () => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      return {
        port: info.port || "",
        token: info.clientToken || "",
        hostToken: info.hostToken || "",
      };
    })()`, { awaitPromise: true });
    state.serverAuth = auth;
    if (auth?.port && auth.token) {
      try {
        response = await fetch(`http://127.0.0.1:${auth.port}/workspace/${encodeURIComponent(state.workspaceId)}/config`, {
          method,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${auth.token}`,
            ...(auth.hostToken ? { "x-openwork-host-token": auth.hostToken } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        break;
      } catch {}
    }
    await sleep(500);
  }
  ctx.assert(response, `${method} workspace config server was unreachable: ${JSON.stringify(auth)}`);
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  ctx.assert(response.ok, `${method} workspace config failed: ${response.status} ${text.slice(0, 800)}`);
  return payload;
}

async function resetEvalProviderImport(ctx) {
  const current = await workspaceConfigRequest(ctx, "GET");
  const cloudImports = current?.openwork?.cloudImports && typeof current.openwork.cloudImports === "object"
    ? current.openwork.cloudImports
    : {};
  await workspaceConfigRequest(ctx, "PATCH", {
    opencode: { provider: { [CUSTOM_PROVIDER.id]: null, openwork: null } },
    openwork: { cloudImports: { ...cloudImports, providers: {} } },
  });
  ctx.recordEvidence({
    type: "assertion",
    status: "passed",
    assertion: "The eval custom Den provider import baseline was reset for idempotence.",
    actual: CUSTOM_PROVIDER.id,
  });
  await ctx.eval("location.reload()");
  await waitForControl(ctx, "control API after eval provider reset");
}

async function signInToCustomDen(ctx) {
  await ctx.eval(`(() => {
    localStorage.setItem("openwork.den.authToken", ${quoted(CUSTOM_TOKEN)});
    localStorage.setItem("openwork.den.activeOrgId", ${quoted(CUSTOM_ORG.id)});
    localStorage.setItem("openwork.den.activeOrgSlug", ${quoted(CUSTOM_ORG.slug)});
    localStorage.setItem("openwork.den.activeOrgName", ${quoted(CUSTOM_ORG.name)});
    ${promoResetScript()};
    ${prefsPatchScript({ hasCompletedOnboarding: true, providerStepCompleted: true })};
    location.hash = ${quoted(`#/workspace/${state.workspaceId}/settings/ai`)};
    location.reload();
    return true;
  })()`);
  await waitForControl(ctx, "control API after custom Den sign-in");
  const deadline = Date.now() + 30_000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    lastStatus = await ctx.control("auth.status").catch((error) => ({ error: error.message }));
    if (lastStatus?.status === "signed_in") return;
    await sleep(500);
  }
  ctx.assert(false, `Custom Den sign-in did not reach signed_in. Last status: ${JSON.stringify(lastStatus)}`);
}

async function cleanup(ctx) {
  try {
    if (state.workspaceId) {
      await resetToDefaultDen(ctx).catch((error) => ctx.log(`Default Den cleanup failed: ${error?.message ?? error}`));
    }
  } finally {
    if (state.customDen) {
      await state.customDen.close().catch((error) => ctx.log(`Custom Den fixture cleanup failed: ${error?.message ?? error}`));
      state.customDen = null;
    }
  }
}

export default {
  id: FLOW_ID,
  title: "Custom Den deployments do not promote OpenWork Models",
  kind: "user-facing",
  steps: [
    {
      name: "Setup dedicated workspace and custom Den fixture",
      run: async (ctx) => {
        let stage = "create dedicated workspace";
        try {
          await createDedicatedWorkspace(ctx);
          stage = "reset provider import";
          await resetEvalProviderImport(ctx);
          stage = "start custom Den fixture";
          state.customDen = await startCustomDenServer();
        } catch (error) {
          throw new Error(`${stage}: ${error?.message ?? error}`);
        }
        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "A dedicated eval workspace and local custom Den fixture are ready.",
          actual: { workspaceId: state.workspaceId, customDenBaseUrl: state.customDen.baseUrl },
        });
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The default OpenWork Cloud Den still exposes OpenWork Models normally", {
          voiceover: vo[0],
          action: async () => {
            await resetToDefaultDen(ctx);
            await closeDialogs(ctx);
            await ctx.navigateHash(`/workspace/${state.workspaceId}/settings/ai`);
            await ctx.waitForText("Providers", { timeoutMs: 60_000 });
            await ctx.waitForText("OpenWork Models", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("OpenWork Models");
            await ctx.expectText("Providers");
            await ctx.expectText("Connected");
          },
          screenshot: {
            name: "frame-1-default-den-openwork-models",
            requireText: ["Providers", "OpenWork Models", "Connected"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The default Den model picker still lists OpenWork Models for eligible users", {
          voiceover: vo[1],
          action: async () => {
            await closeDialogs(ctx);
            await ctx.eval(promoResetScript());
            await openModelPicker(ctx);
            await ctx.waitForText("OpenWork Models", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("OpenWork Models");
            await ctx.expectText("Models");
          },
          screenshot: {
            name: "frame-2-default-den-model-picker-promo",
            requireText: ["Models", "OpenWork Models"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The desktop app can be switched from default Den to the custom Den URL", {
          voiceover: vo[2],
          action: async () => {
            await closeDialogs(ctx);
            await ctx.navigateHash(`/workspace/${state.workspaceId}/settings/advanced`);
            await ctx.waitForText("Organization server", { timeoutMs: 60_000 });
            await ctx.fill(`input[placeholder=${quoted(DEFAULT_DEN_BASE_URL)}]`, state.customDen.baseUrl);
            await ctx.clickText("Save", { selector: "[data-section] button, button", timeoutMs: 15_000 });
            await ctx.waitForText(`Current organization server: ${state.customDen.baseUrl}`, { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("Organization server");
            await ctx.expectText(`Current organization server: ${state.customDen.baseUrl}`);
            const stored = await ctx.eval(`(async () => {
              const config = await window.__OPENWORK_ELECTRON__.invokeDesktop("getDesktopBootstrapConfig");
              return config?.baseUrl || "";
            })()`, { awaitPromise: true });
            ctx.assert(stored === state.customDen.baseUrl, `Expected desktop bootstrap Den URL to be ${state.customDen.baseUrl}, got ${stored}`);
          },
          screenshot: {
            name: "frame-3-custom-den-configured",
            requireText: ["Organization server", `Current organization server: ${state.customDen.baseUrl}`, "Save", "Reset"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("On the custom Den, the model picker shows normal available models without OpenWork Models promos", {
          voiceover: vo[3],
          action: async () => {
            await ctx.eval(`(() => {
              ${clearDenSessionScript()};
              ${promoResetScript()};
              ${prefsPatchScript({ hasCompletedOnboarding: true, providerStepCompleted: true })};
              location.reload();
              return true;
            })()`);
            await waitForControl(ctx, "control API after custom Den reload");
            await waitForWorkspaceReady(ctx);
            await sleep(2_000);
            await openModelPicker(ctx);
          },
          assert: async () => {
            await ctx.expectText("Models");
            await assertNoPromoText(ctx, "custom Den model picker");
          },
          screenshot: {
            name: "frame-4-custom-den-model-picker-no-promos",
            requireText: ["Models", "Select a model for this session."],
            rejectText: PROMO_REJECT_TEXT,
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Custom Den suppresses OpenWork Models promos across startup, status, AI settings, provider setup, welcome, and first-task surfaces", {
          voiceover: vo[4],
          action: async () => {
            await closeDialogs(ctx);
            await ctx.eval(`(() => {
              ${clearDenSessionScript()};
              ${promoResetScript()};
              ${prefsPatchScript({ hasCompletedOnboarding: true, providerStepCompleted: true })};
              location.hash = ${quoted(`#/workspace/${state.workspaceId}/session/${state.sessionId}`)};
              location.reload();
              return true;
            })()`);
            await waitForControl(ctx, "control API after custom Den startup reload");
            await sleep(1_500);
            await assertNoPromoText(ctx, "custom Den startup");

            await ctx.eval(promoResetScript());
            await sleep(4_800);
            await assertNoPromoText(ctx, "custom Den status bar");

            await ctx.eval(`(() => {
              ${prefsPatchScript({ hasCompletedOnboarding: false, providerStepCompleted: false })};
              location.hash = "#/welcome";
              location.reload();
              return true;
            })()`);
            await ctx.waitForText("Pick a folder to get started", { timeoutMs: 30_000 });
            await assertNoPromoText(ctx, "custom Den welcome");

            await ctx.eval(`(() => {
              ${prefsPatchScript({ hasCompletedOnboarding: true, providerStepCompleted: true })};
              location.hash = ${quoted(`#/workspace/${state.workspaceId}/settings/ai`)};
              location.reload();
              return true;
            })()`);
            await waitForControl(ctx, "control API before custom Den AI settings");
            await ctx.waitForText("Providers", { timeoutMs: 60_000 });
            await assertNoPromoText(ctx, "custom Den AI settings");
            await ctx.eval(`(() => {
              ${prefsPatchScript({ hasCompletedOnboarding: false, providerStepCompleted: false })};
              location.hash = "#/welcome";
              location.reload();
              return true;
            })()`);
            await ctx.waitForText("Pick a folder to get started", { timeoutMs: 30_000 });
            await assertNoPromoText(ctx, "custom Den welcome screenshot state");
          },
          assert: async () => {
            await ctx.expectText("Pick a folder to get started");
            await assertNoPromoText(ctx, "custom Den welcome screenshot state");
          },
          screenshot: {
            name: "frame-5-custom-den-welcome-no-promos",
            requireText: ["Pick a folder to get started"],
            rejectText: PROMO_REJECT_TEXT,
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("Signing in to the custom Den keeps promos hidden while organization-provided models import and appear", {
          voiceover: vo[5],
          action: async () => {
            await closeDialogs(ctx);
            await signInToCustomDen(ctx);
            await ctx.waitForText("Cloud providers", { timeoutMs: 60_000 });
            await ctx.clickText("Refresh", { selector: "button", timeoutMs: 30_000 }).catch(() => undefined);
            await ctx.waitForText(CUSTOM_PROVIDER.name, { timeoutMs: 45_000 });
            await assertNoPromoText(ctx, "custom Den signed-in AI settings");
          },
          assert: async () => {
            await ctx.expectText(CUSTOM_PROVIDER.name);
            await ctx.expectText("Cloud providers");
            await ctx.expectText("1 models");
            await assertNoPromoText(ctx, "custom Den signed-in provider list");
            const denRequests = state.customDen.requests.filter((request) => request.path.startsWith("/v1/llm-providers"));
            ctx.recordEvidence({
              type: "assertion",
              status: denRequests.length > 0 ? "passed" : "failed",
              assertion: "The signed-in custom Den was queried for organization LLM providers.",
              actual: denRequests,
            });
            ctx.assert(denRequests.length > 0, "The app did not query the custom Den LLM provider endpoints.");
          },
          screenshot: {
            name: "frame-6-custom-den-org-models-visible-no-promos",
            requireText: ["Cloud providers", CUSTOM_PROVIDER.name, "1 models"],
            rejectText: PROMO_REJECT_TEXT,
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: cleanup,
    },
  ],
};
