import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "cloud-mcp-submit-readiness";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const ORIGINAL_PROMPT = "Search my connected services for the latest reliability report.";
const EDITED_PROMPT = `${ORIGINAL_PROMPT} Keep this edit while tools are prepared.`;
const SIGNED_OUT_PROMPT = "Run this local task while OpenWork Cloud is signed out.";
const HEALTH_DELAY_MS = 8_000;
const DEMO_EMAIL = "alex@acme.test";
const DEMO_PASSWORD = "OpenWorkDemo123!";
const EVAL_SESSION_TOKEN_KEY = "openwork.eval.cloudMcpSubmitReadiness.sessionToken";

const state = {
  workspaceId: null,
  provider: null,
  model: null,
  serverAuth: null,
  sessionId: null,
  transcriptCount: 0,
};

function quoted(value) {
  return JSON.stringify(value);
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : JSON.stringify(actual).slice(0, 1_200),
  });
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : `. Actual: ${JSON.stringify(actual).slice(0, 600)}`}`);
}

async function serverFetchJson(path) {
  const response = await fetch(`http://127.0.0.1:${state.serverAuth.port}${path}`, {
    headers: {
      authorization: `Bearer ${state.serverAuth.token}`,
      ...(state.serverAuth.hostToken ? { "x-openwork-host-token": state.serverAuth.hostToken } : {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

async function waitForLiveCloudHealth(query) {
  const deadline = Date.now() + 60_000;
  let health = null;
  while (Date.now() < deadline) {
    health = await serverFetchJson(`/workspace/${encodeURIComponent(state.workspaceId)}/mcp/openwork-cloud/health?${query.toString()}`);
    if (health.usable === true && health.engine?.status === "connected") return health;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return health;
}

async function restorePriorEvalProbes(ctx) {
  await releaseSavedSessionRestore(ctx).catch(() => undefined);
  await ctx.eval(`(() => {
    const bridge = window.__OPENWORK_ELECTRON__;
    const reliability = window.__cloudMcpReliabilityProbe;
    if (reliability?.retryTimer) window.clearInterval(reliability.retryTimer);
    if (bridge && reliability?.originalInvoke) bridge.invokeDesktop = reliability.originalInvoke;
    localStorage.removeItem("openwork.eval.cloudMcpReliability.guard");
    localStorage.removeItem("openwork.eval.cloudMcpReliability.blockedDesktopFetches");
    delete window.__cloudMcpReliabilityProbe;

    const readiness = window.__cloudMcpSubmitReadinessProbe;
    if (bridge && readiness?.originalInvoke) bridge.invokeDesktop = readiness.originalInvoke;
    if (readiness?.originalFetch) window.fetch = readiness.originalFetch;
    delete window.__cloudMcpSubmitReadinessProbe;
    const savedSessionToken = localStorage.getItem(${quoted(EVAL_SESSION_TOKEN_KEY)});
    if (savedSessionToken) localStorage.setItem("openwork.den.authToken", savedSessionToken);
    localStorage.removeItem(${quoted(EVAL_SESSION_TOKEN_KEY)});
    return true;
  })()`);
}

async function installSubmissionProbe(ctx) {
  const result = await ctx.eval(`(() => {
    const bridge = window.__OPENWORK_ELECTRON__;
    if (!bridge?.invokeDesktop) return { ok: false, reason: "desktop bridge unavailable" };
    const originalInvoke = bridge.invokeDesktop.bind(bridge);
    const originalFetch = window.fetch.bind(window);
    const probe = {
      originalInvoke,
      originalFetch,
      healthCalls: [],
      delayMs: ${HEALTH_DELAY_MS},
    };
    const delayHealth = async (url, method, channel) => {
      if (method !== "GET" || !url.includes("/mcp/openwork-cloud/health")) return;
      probe.healthCalls.push({ at: Date.now(), method, url, channel });
      await new Promise((resolve) => window.setTimeout(resolve, probe.delayMs));
    };
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input?.url || String(input);
      const method = String(init?.method || input?.method || "GET").toUpperCase();
      await delayHealth(url, method, "window.fetch");
      return originalFetch(input, init);
    };
    bridge.invokeDesktop = async (command, ...args) => {
      if (command === "__fetch") {
        const url = String(args[0] || "");
        const init = args[1] && typeof args[1] === "object" ? args[1] : {};
        const method = String(init.method || "GET").toUpperCase();
        await delayHealth(url, method, "desktop.__fetch");
      }
      return originalInvoke(command, ...args);
    };
    window.__cloudMcpSubmitReadinessProbe = probe;
    return { ok: bridge.invokeDesktop !== originalInvoke, delayMs: probe.delayMs };
  })()`);
  witness(ctx, result?.ok === true && result.delayMs === HEALTH_DELAY_MS, "A bounded eval delay makes the real pre-send readiness state observable.", result);
}

async function dismissModelUpsells(ctx) {
  if (await ctx.hasText("Use OpenWork Models without API keys")) {
    await ctx.clickText("Continue without OpenWork Models", { selector: "button", timeoutMs: 15_000 });
    await ctx.waitFor("!document.body.innerText.includes('Use OpenWork Models without API keys')", {
      timeoutMs: 15_000,
      label: "OpenWork Models upsell dismissed",
    });
  }
  if (await ctx.hasText("Power your first task")) {
    await ctx.clickText("Skip and use the free model", { selector: "button", timeoutMs: 15_000 });
    await ctx.waitFor("!document.body.innerText.includes('Power your first task')", {
      timeoutMs: 15_000,
      label: "first task model upsell dismissed",
    });
  }
}

async function beginSavedSessionRestore(ctx) {
  const held = await fetch(`${ctx.env.OPENWORK_EVAL_DEN_API_URL.replace(/\/+$/, "")}/__openwork_eval/auth-delay?action=hold`, {
    method: "POST",
  });
  ctx.assert(held.ok, `The eval auth-delay control is unavailable (${held.status}).`);
  const result = await ctx.eval("Boolean((localStorage.getItem('openwork.den.authToken') || '').trim())");
  witness(ctx, result === true, "The live desktop begins restoring its saved Cloud session.", result);
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API while saved Cloud session validation is paused",
  });
  await dismissModelUpsells(ctx);
  await installSubmissionProbe(ctx);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = await readAuthDelay(ctx);
    if (status.calls >= 1 && status.pending === status.calls) {
      await ctx.waitFor(
        "window.__openworkControl?.listActions?.().some((action) => action.id === 'composer.set_text' && !action.disabled)",
        { timeoutMs: 15_000, label: "composer remains available during saved Cloud session validation" },
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the saved Cloud session validation to pause.");
}

async function releaseSavedSessionRestore(ctx) {
  const baseUrl = ctx.env.OPENWORK_EVAL_DEN_API_URL?.replace(/\/+$/, "") ?? "";
  if (!baseUrl) return;
  const response = await fetch(`${baseUrl}/__openwork_eval/auth-delay?action=release`, {
    method: "POST",
  });
  if (!response.ok) throw new Error(`The eval auth-delay release failed (${response.status}).`);
}

async function readAuthDelay(ctx) {
  const response = await fetch(`${ctx.env.OPENWORK_EVAL_DEN_API_URL.replace(/\/+$/, "")}/__openwork_eval/auth-delay`);
  if (!response.ok) throw new Error(`The eval auth-delay status failed (${response.status}).`);
  return response.json();
}

async function setSignedOutForSubmission(ctx) {
  await ctx.eval(`(async () => {
    const token = (localStorage.getItem("openwork.den.authToken") || "").trim();
    if (token) localStorage.setItem(${quoted(EVAL_SESSION_TOKEN_KEY)}, token);
    localStorage.removeItem("openwork.den.authToken");
    return true;
  })()`, { awaitPromise: true });
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API after signed-out restart",
  });
  await ctx.waitFor(
    "window.__openworkControl?.listActions?.().some((action) => action.id === 'composer.set_text' && !action.disabled)",
    { timeoutMs: 15_000, label: "composer available after signed-out restart" },
  );
}

async function restoreSavedSession(ctx) {
  await ctx.eval(`(async () => {
    const token = localStorage.getItem(${quoted(EVAL_SESSION_TOKEN_KEY)});
    if (token) localStorage.setItem("openwork.den.authToken", token);
    localStorage.removeItem(${quoted(EVAL_SESSION_TOKEN_KEY)});
    window.dispatchEvent(new CustomEvent("openwork-den-session-updated", {
      detail: { status: "success" },
    }));
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    return Boolean((localStorage.getItem("openwork.den.authToken") || "").trim());
  })()`, { awaitPromise: true });
}

async function readComposerState(ctx) {
  return ctx.eval(`(() => {
    const editor = [...document.querySelectorAll('[contenteditable="true"]')]
      .find((entry) => entry.closest('[data-slot="card"], form, [class*="composer"]'))
      || document.querySelector('[contenteditable="true"]');
    const buttons = [...document.querySelectorAll('button')];
    const preparing = buttons.find((button) => button.title === "Preparing connected service tools…"
      || (button.textContent || "").includes("Preparing connected service tools…"));
    const attach = buttons.find((button) => button.title === "Attach files" || button.getAttribute('aria-label') === "Attach files");
    return {
      editorText: (editor?.innerText || editor?.textContent || "").replace(/\\s+/g, " ").trim(),
      editorEditable: editor?.getAttribute('contenteditable') === "true",
      preparingVisible: Boolean(preparing),
      preparingDisabled: preparing?.disabled === true,
      attachDisabled: attach?.disabled === true,
      hash: window.location.hash,
    };
  })()`);
}

async function readProbe(ctx) {
  return ctx.eval(`(() => {
    const probe = window.__cloudMcpSubmitReadinessProbe;
    return {
      installed: Boolean(probe),
      delayMs: probe?.delayMs ?? null,
      healthCalls: (probe?.healthCalls ?? []).map((entry) => ({ ...entry })),
    };
  })()`);
}

async function transcriptCount(ctx) {
  const result = await ctx.eval(
    "window.__openworkControl.execute('session.read_transcript', { count: 30 })",
    { awaitPromise: true },
  );
  if (result?.ok === true) return result.result?.messages?.length ?? 0;
  if (result?.error === "No messages in this session") return 0;
  throw new Error(`Could not read the active session transcript: ${result?.error ?? "unknown error"}`);
}

async function createFreshTask(ctx) {
  const deadline = Date.now() + 15_000;
  let lastError = "unavailable";
  while (Date.now() < deadline) {
    const result = await ctx.eval(
      "window.__openworkControl.execute('session.create_task', null)",
      { awaitPromise: true },
    );
    if (result?.ok === true) return;
    lastError = result?.error ?? "unknown error";
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Could not create a fresh task: ${lastError}`);
}

async function waitForTranscriptIncrease(ctx, before) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const count = await transcriptCount(ctx);
    if (count > before) return count;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Transcript did not grow beyond ${before}.`);
}

async function ensureLocalCloudSession(ctx) {
  const denBaseUrl = ctx.env.OPENWORK_EVAL_DEN_API_URL?.trim() ?? "";
  const denOrigin = ctx.env.OPENWORK_EVAL_DEN_ORIGIN?.trim() || denBaseUrl;
  let token = ctx.env.OPENWORK_EVAL_DEN_TOKEN?.trim() ?? "";
  ctx.assert(denBaseUrl, "The isolated Den stack URL is missing.");
  if (!token) {
    const signIn = await fetch(`${denBaseUrl.replace(/\/+$/, "")}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: denOrigin },
      body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
    });
    ctx.assert(signIn.ok, `The isolated Den demo account could not sign in (${signIn.status}).`);
    const payload = await signIn.json();
    token = typeof payload?.token === "string" ? payload.token.trim() : "";
  }
  ctx.assert(token, "The isolated Den demo sign-in did not return a session.");
  const response = await fetch(`${denBaseUrl.replace(/\/+$/, "")}/v1/me/orgs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(response.ok, `The isolated Den stack could not resolve the demo organization (${response.status}).`);
  const payload = await response.json();
  const orgs = Array.isArray(payload?.orgs) ? payload.orgs : [];
  const org = orgs.find((entry) => entry.id === payload.activeOrgId) ?? orgs[0];
  ctx.assert(org?.id, "The isolated Den demo session has no organization.");
  await ctx.eval(`(() => {
    localStorage.setItem("openwork.den.baseUrl", ${quoted(denBaseUrl)});
    localStorage.setItem("openwork.den.authToken", ${quoted(token)});
    localStorage.setItem("openwork.den.activeOrgId", ${quoted(org.id)});
    ${org.slug ? `localStorage.setItem("openwork.den.activeOrgSlug", ${quoted(org.slug)});` : "localStorage.removeItem(\"openwork.den.activeOrgSlug\");"}
    ${org.name ? `localStorage.setItem("openwork.den.activeOrgName", ${quoted(org.name)});` : "localStorage.removeItem(\"openwork.den.activeOrgName\");"}
    window.dispatchEvent(new CustomEvent("openwork-den-settings-changed"));
    window.dispatchEvent(new CustomEvent("openwork-den-session-updated", {
      detail: { status: "success" },
    }));
    return true;
  })()`);
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API after isolated Cloud session restore",
  });
}

async function setup(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
  await restorePriorEvalProbes(ctx);
  await ensureLocalCloudSession(ctx);

  const context = await ctx.eval(`(() => {
    const prefs = JSON.parse(localStorage.getItem("openwork.preferences") || "{}");
    const hashWorkspace = (window.location.hash.match(new RegExp("/workspace/([^/]+)")) || [])[1] || "";
    return {
      signedIn: Boolean((localStorage.getItem("openwork.den.authToken") || "").trim()),
      orgId: (localStorage.getItem("openwork.den.activeOrgId") || "").trim(),
      workspaceId: hashWorkspace || (localStorage.getItem("openwork.react.activeWorkspace") || "").trim(),
      provider: prefs.defaultModel?.providerID || "",
      model: prefs.defaultModel?.modelID || "",
      port: (localStorage.getItem("openwork.server.port") || "").trim(),
      token: (localStorage.getItem("openwork.server.token") || "").trim(),
      hostToken: (localStorage.getItem("openwork.server.hostToken") || "").trim(),
    };
  })()`);
  ctx.assert(context.signedIn && context.orgId, "This flow requires a signed-in local Cloud demo organization.");
  ctx.assert(
    context.workspaceId && context.provider && context.model,
    `Workspace/model context is incomplete: ${JSON.stringify({
      workspaceId: context.workspaceId,
      provider: context.provider,
      model: context.model,
      hasPort: Boolean(context.port),
      hasToken: Boolean(context.token),
      hasHostToken: Boolean(context.hostToken),
    })}`,
  );
  ctx.assert(context.port && context.token, "OpenWork server credentials are unavailable in the isolated desktop.");
  state.workspaceId = context.workspaceId;
  state.provider = context.provider;
  state.model = context.model;
  state.serverAuth = { port: context.port, token: context.token, hostToken: context.hostToken };

  const query = new URLSearchParams({ provider: state.provider, model: state.model });
  const health = await waitForLiveCloudHealth(query);
  witness(ctx, health.usable === true && health.engine?.status === "connected", "The live Cloud transport and direct endpoint are healthy before the submission proof.", {
    usable: health.usable,
    engine: health.engine?.status,
  });
  witness(ctx, health.tools?.direct?.present?.includes("search_capabilities") && health.tools?.direct?.present?.includes("execute_capability"), "The live Cloud endpoint directly lists search_capabilities and execute_capability.", health.tools?.direct);
  witness(ctx, health.tools?.providerProjection?.source === "provider_capability" && health.tools.providerProjection.missing?.length === 2, "The bundled engine exposes only generic model tool-calling support and cannot prove the selected-model Cloud tool projection.", health.tools?.providerProjection);

  await ctx.navigateHash(`/workspace/${state.workspaceId}/session`);
  await ctx.waitFor(
    "window.__openworkControl?.listActions?.().some((action) => action.id === 'session.create_task' && !action.disabled)",
    { timeoutMs: 45_000, label: "session.create_task enabled" },
  );
  await createFreshTask(ctx);
  await ctx.waitFor("window.location.hash.includes('/session/ses_')", { timeoutMs: 45_000, label: "fresh task session" });
  await dismissModelUpsells(ctx);
  state.sessionId = (await ctx.eval("(window.location.hash.match(new RegExp('/session/(ses_[^/?#]+)')) || [])[1] || null"));
  ctx.assert(state.sessionId, "Fresh task session id was not found in the route.");
  state.transcriptCount = await transcriptCount(ctx);
  witness(ctx, state.transcriptCount === 0, "The submission proof starts from a task with no messages or agent run.", { transcriptCount: state.transcriptCount });
}

export default {
  id: FLOW_ID,
  title: "Cloud submissions wait for selected-model tool proof and fail closed",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL"],
  steps: [
    {
      name: "Setup: use the live signed-in workspace and bundled engine contract gap",
      run: setup,
    },
    {
      name: "Frame 1: preparation keeps the composer usable",
      run: async (ctx) => {
        await ctx.prove("Submission preparation keeps the draft editable and prevents duplicate sends before any run starts", {
          voiceover: vo[0],
          action: async () => {
            await beginSavedSessionRestore(ctx);
            await ctx.control("composer.set_text", { text: ORIGINAL_PROMPT });
            const clicked = await ctx.eval(`(() => {
              const button = [...document.querySelectorAll('button')].find((entry) => entry.title === "Run task");
              button?.click();
              return Boolean(button);
            })()`);
            ctx.assert(clicked, "Could not click the visible Run task button.");
            await ctx.waitFor(
              "document.body.innerText.includes('Preparing connected service tools…') || document.body.innerText.includes('Power your first task')",
              { timeoutMs: 5_000, label: "submission preparation or first-task model choice" },
            );
            if (await ctx.hasText("Power your first task")) {
              await dismissModelUpsells(ctx);
              await ctx.control("composer.set_text", { text: ORIGINAL_PROMPT });
              const retried = await ctx.waitFor(`(() => {
                const button = [...document.querySelectorAll('button')].find((entry) => entry.title === "Run task");
                if (!button || button.disabled) return false;
                button.click();
                return true;
              })()`, { timeoutMs: 10_000, label: "Run task after first-task model choice" });
              ctx.assert(retried, "Could not resubmit after the first-task model choice.");
            }
            await ctx.waitForText("Preparing connected service tools…", { timeoutMs: 5_000 });
            await ctx.control("composer.set_text", { text: EDITED_PROMPT });
            await ctx.eval(`(() => {
              const button = [...document.querySelectorAll('button')].find((entry) => entry.title === "Preparing connected service tools…");
              button?.click();
              button?.click();
              return true;
            })()`);
          },
          assert: async () => {
            const composer = await readComposerState(ctx);
            witness(ctx, composer.preparingVisible && composer.preparingDisabled, "Only the queued send action is disabled while connected service tools are prepared.", composer);
            witness(ctx, composer.editorEditable && composer.editorText === EDITED_PROMPT && composer.attachDisabled !== true, "The editor remains editable, the user's edit is visible, and attachment access is not disabled.", composer);
            const after = await transcriptCount(ctx);
            witness(ctx, after === state.transcriptCount, "No user message or agent run was created while readiness was still checking.", { before: state.transcriptCount, after });
            const probe = await readProbe(ctx);
            const authDelay = await readAuthDelay(ctx);
            witness(ctx, authDelay.calls >= 1 && authDelay.pending === authDelay.calls && probe.healthCalls.length === 0, "The queued submission waits for saved-session validation before checking tools or creating a run.", { authDelay, probe });
            await releaseSavedSessionRestore(ctx);
          },
          screenshot: {
            name: "cloud-submit-preparing-editable",
            claim: "The queued submission shows Preparing connected service tools while the edited draft remains in the usable composer.",
            requireText: ["Preparing connected service tools…", EDITED_PROMPT],
            rejectText: ["Stop", "Something went wrong"],
            hashIncludes: `/workspace/${state.workspaceId}/session/`,
          },
        });
      },
    },
    {
      name: "Frame 2: unprovable projection fails closed",
      run: async (ctx) => {
        await ctx.prove("An unprovable selected-model projection creates no run and preserves the draft with safe recovery actions", {
          voiceover: vo[1],
          action: async () => {
            await ctx.waitForText("The current engine cannot prove that connected service tools were injected into the selected model.", { timeoutMs: 20_000 });
            await ctx.waitForText("Retry", { timeoutMs: 5_000 });
            await ctx.waitForText("Open Connect", { timeoutMs: 5_000 });
          },
          assert: async () => {
            const composer = await readComposerState(ctx);
            witness(ctx, composer.editorEditable && composer.editorText === EDITED_PROMPT, "The exact visible edited draft remains available after readiness fails.", composer);
            const after = await transcriptCount(ctx);
            witness(ctx, after === state.transcriptCount, "Permanent projection failure created no user message and no agent run.", { before: state.transcriptCount, after });
            const probe = await readProbe(ctx);
            witness(ctx, probe.healthCalls.length >= 1 && probe.healthCalls.length <= 2, "The non-retryable projection gap stops after the queued send and concurrent startup health checks, without a retry loop.", probe);
          },
          screenshot: {
            name: "cloud-submit-projection-failure-preserves-draft",
            claim: "The selected-model projection gap fails closed with the draft preserved and Retry/Open Connect actions.",
            requireText: ["The current engine cannot prove that connected service tools were injected into the selected model.", "Retry", "Open Connect", EDITED_PROMPT],
            rejectText: ["Stop", "search_capabilities was unavailable but the task was sent"],
            hashIncludes: `/workspace/${state.workspaceId}/session/`,
          },
        });
      },
    },
    {
      name: "Frame 3: signed-out Cloud keeps the existing local send path",
      run: async (ctx) => {
        await ctx.prove("A user who is actually signed out is not held behind the Cloud readiness gate", {
          voiceover: vo[2],
          action: async () => {
            await ctx.navigateHash(`/workspace/${state.workspaceId}/session`);
            await ctx.waitFor(
              "window.__openworkControl?.listActions?.().some((action) => action.id === 'session.create_task' && !action.disabled)",
              { timeoutMs: 45_000, label: "session.create_task enabled for signed-out proof" },
            );
            await createFreshTask(ctx);
            await ctx.waitFor("window.location.hash.includes('/session/ses_')", { timeoutMs: 45_000, label: "fresh signed-out task session" });
            const before = await transcriptCount(ctx);
            await setSignedOutForSubmission(ctx);
            await ctx.control("composer.set_text", { text: SIGNED_OUT_PROMPT });
            const clicked = await ctx.eval(`(() => {
              const button = [...document.querySelectorAll('button')].find((entry) => entry.title === "Run task");
              button?.click();
              return Boolean(button);
            })()`);
            ctx.assert(clicked, "Could not click Run task while Cloud was signed out.");
            state.transcriptCount = await waitForTranscriptIncrease(ctx, before);
          },
          assert: async () => {
            const composer = await readComposerState(ctx);
            witness(ctx, !composer.preparingVisible, "The signed-out submission never enters connected-service preparation.", composer);
            witness(ctx, state.transcriptCount > 0, "The existing send path creates the user message while Cloud is signed out.", { transcriptCount: state.transcriptCount });
            await restoreSavedSession(ctx);
          },
          screenshot: {
            name: "cloud-submit-signed-out-bypasses-gate",
            claim: "A signed-out user submits through the existing local path without a connected-service preparation state.",
            requireText: [SIGNED_OUT_PROMPT],
            rejectText: ["Preparing connected service tools…"],
            hashIncludes: `/workspace/${state.workspaceId}/session/`,
          },
        });
      },
    },
    {
      name: "Cleanup readiness delay",
      run: async (ctx) => {
        await restorePriorEvalProbes(ctx);
      },
    },
  ],
};
