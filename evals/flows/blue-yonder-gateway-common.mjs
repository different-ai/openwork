const CLICKABLE_SELECTOR = "button, [role=button], a, div, article, li, label";
const EDITOR_SELECTOR = '[contenteditable="true"][data-lexical-editor="true"]';
const DEFAULT_PASSWORD = "TutorialDemo123!";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function envText(ctx, name) {
  return (ctx.env[name] ?? "").trim();
}

export function cleanBase(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

export function denApiBase(ctx) {
  const value = cleanBase(envText(ctx, "OPENWORK_EVAL_DEN_API_URL"));
  ctx.assert(Boolean(value), "Missing OPENWORK_EVAL_DEN_API_URL for the Blue Yonder eval flow.");
  return value;
}

export function denWebBase(ctx) {
  return cleanBase(envText(ctx, "OPENWORK_EVAL_DEN_WEB_URL") || denApiBase(ctx));
}

export function workspaceFolder(ctx, envName, fallback) {
  return envText(ctx, envName) || fallback;
}

export function timeoutMs(ctx, envName, fallback) {
  const raw = envText(ctx, envName) || envText(ctx, "OPENWORK_EVAL_BLUE_YONDER_TASK_TIMEOUT_MS");
  if (!raw) return fallback;
  const value = Number(raw);
  ctx.assert(Number.isFinite(value) && value > 0, `${envName} must be a positive millisecond timeout.`);
  return value;
}

function actualText(value) {
  if (typeof value === "string") return value.slice(0, 2_000);
  try {
    return JSON.stringify(value).slice(0, 2_000);
  } catch {
    return String(value).slice(0, 2_000);
  }
}

export function assertEvidence(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual: actualText(actual) });
  ctx.assert(condition, `${assertion}${actual ? `. Actual: ${actualText(actual)}` : ""}`);
}

async function denApiFetch(ctx, pathname, init = {}) {
  const response = await fetch(`${denApiBase(ctx)}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      origin: denWebBase(ctx),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

export async function signInByEmail(ctx, email) {
  const result = await denApiFetch(ctx, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password: envText(ctx, "OPENWORK_EVAL_BLUE_YONDER_PASSWORD") || DEFAULT_PASSWORD }),
  });
  ctx.assert(result.response.ok, `Blue Yonder sign-in failed for ${email}: ${result.response.status} ${result.text.slice(0, 400)}`);
  const token = result.body?.token;
  ctx.assert(typeof token === "string" && token.trim().length > 0, `Blue Yonder sign-in for ${email} returned no bearer token.`);
  return token.trim();
}

export async function createDesktopHandoff(ctx, token) {
  const result = await denApiFetch(ctx, "/v1/auth/desktop-handoff", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ desktopScheme: "openwork" }),
  });
  ctx.assert(result.response.ok, `Desktop handoff create failed: ${result.response.status} ${result.text.slice(0, 400)}`);
  const openworkUrl = result.body?.openworkUrl;
  ctx.assert(typeof openworkUrl === "string" && openworkUrl.length > 0, "Desktop handoff response did not include openworkUrl.");
  const url = new URL(openworkUrl);
  if (!url.searchParams.get("denBaseUrl")) url.searchParams.set("denBaseUrl", denApiBase(ctx));
  return url.toString();
}

export async function configureDesktopForDen(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 120_000, label: "OpenWork control API" });
  const apiBase = denApiBase(ctx);
  const result = await ctx.eval(`(async () => {
    const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (bridge) {
      await bridge("setDesktopBootstrapConfig", { baseUrl: ${JSON.stringify(apiBase)}, apiBaseUrl: ${JSON.stringify(apiBase)}, requireSignin: false, handoff: null });
    }
    localStorage.setItem("openwork.den.baseUrl", ${JSON.stringify(apiBase)});
    localStorage.setItem("openwork.den.apiBaseUrl", ${JSON.stringify(apiBase)});
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem("openwork.preferences") || "{}"); } catch {}
    localStorage.setItem("openwork.preferences", JSON.stringify({ ...prefs, selectedAgent: "openwork" }));
    return { bridge: Boolean(bridge) };
  })()`, { awaitPromise: true });
  ctx.log(`Configured Den base for desktop (${result?.bridge ? "desktop bridge" : "renderer only"}).`);
}

export async function resetDesktopDenSession(ctx) {
  await ctx.eval(`(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("openwork.den.mcp")) localStorage.removeItem(key);
    }
    for (const key of ["openwork.den.authToken", "openwork.den.activeOrgId", "openwork.den.activeOrgSlug", "openwork.den.activeOrgName"]) {
      localStorage.removeItem(key);
    }
    window.dispatchEvent(new CustomEvent("openwork-den-session-updated", { detail: { status: "signed_out" } }));
    return true;
  })()`);
}

export async function deliverDesktopDeepLink(ctx, openworkUrl) {
  await ctx.eval(`(() => {
    const url = ${JSON.stringify(openworkUrl)};
    window.__OPENWORK__ = window.__OPENWORK__ || {};
    window.__OPENWORK__.deepLinks = [...(window.__OPENWORK__.deepLinks || []), url];
    window.dispatchEvent(new CustomEvent("openwork:deep-link", { detail: { urls: [url], denBaseUrl: ${JSON.stringify(denApiBase(ctx))} } }));
    return true;
  })()`);
}

export async function clickExactText(ctx, text, selector = "button, [role=button], a", timeout = 20_000) {
  await ctx.waitFor(`(() => {
    const normalize = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((entry) => normalize(entry.textContent) === ${JSON.stringify(text)} && entry.disabled !== true && entry.getAttribute("aria-disabled") !== "true");
    element?.scrollIntoView({ block: "center", inline: "center" });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: timeout, label: `exact clickable text ${JSON.stringify(text)}` });
}

export async function clickExactIfVisible(ctx, text, selector = "button, [role=button], a") {
  return Boolean(await ctx.eval(`(() => {
    const normalize = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((entry) => normalize(entry.textContent) === ${JSON.stringify(text)} && entry.disabled !== true && entry.getAttribute("aria-disabled") !== "true");
    element?.scrollIntoView({ block: "center", inline: "center" });
    element?.click();
    return Boolean(element);
  })()`));
}

async function clickNearestExactIfVisible(ctx, text) {
  return Boolean(await ctx.eval(`(() => {
    const normalize = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
    const labels = [...document.querySelectorAll("*")].filter((entry) => normalize(entry.textContent) === ${JSON.stringify(text)});
    labels.sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length);
    const target = labels[0]?.closest(${JSON.stringify(CLICKABLE_SELECTOR)}) || labels[0];
    target?.scrollIntoView({ block: "center", inline: "center" });
    target?.click();
    return Boolean(target);
  })()`));
}

export async function completeBlueYonderOrgOnboarding(ctx) {
  const deadline = Date.now() + 90_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await ctx.eval(`(() => {
      const text = document.body.innerText || "";
      const buttons = [...document.querySelectorAll("button, [role=button]")].map((entry) => (entry.textContent ?? "").replace(/\\s+/g, " ").trim());
      return {
        hash: window.location.hash,
        activeOrgName: localStorage.getItem("openwork.den.activeOrgName") || "",
        hasChoose: text.includes("Choose your organization"),
        hasBlueYonder: text.includes("Blue Yonder"),
        hasContinueOrg: buttons.includes("Continue with organization"),
        hasContinueWorkspace: buttons.includes("Continue to workspace"),
        hasFolderInput: Boolean(document.querySelector('input[placeholder="/workspace/my-project"]')),
      };
    })()`);
    if (last.hasFolderInput || last.hash.includes("/welcome")) return;
    if (last.activeOrgName === "Blue Yonder" && !last.hasChoose && !last.hasContinueOrg && !last.hasContinueWorkspace) return;
    if (last.hasChoose && last.hasBlueYonder && await clickNearestExactIfVisible(ctx, "Blue Yonder")) {
      await sleep(750);
      continue;
    }
    if (last.hasContinueOrg && await clickExactIfVisible(ctx, "Continue with organization", "button, [role=button]")) {
      await sleep(1_000);
      continue;
    }
    if (last.hasContinueWorkspace && await clickExactIfVisible(ctx, "Continue to workspace", "button, [role=button]")) {
      await sleep(1_000);
      continue;
    }
    if (last.activeOrgName === "Blue Yonder") return;
    await sleep(750);
  }
  throw new Error(`Blue Yonder org onboarding did not settle: ${JSON.stringify(last)}`);
}

export async function desktopHandoffSignIn(ctx, email) {
  await configureDesktopForDen(ctx);
  await resetDesktopDenSession(ctx);
  const token = await signInByEmail(ctx, email);
  const openworkUrl = await createDesktopHandoff(ctx, token);
  await deliverDesktopDeepLink(ctx, openworkUrl);
  await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", { timeoutMs: 60_000, label: "desktop Den token" });
  await completeBlueYonderOrgOnboarding(ctx);
  await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.activeOrgId') ?? '').trim())", { timeoutMs: 60_000, label: "desktop active organization" });
  return token;
}

function localServerExpr() {
  return `(() => {
    const urlOverride = (localStorage.getItem("openwork.server.urlOverride") || "").trim();
    const active = (localStorage.getItem("openwork.server.active") || "").trim();
    const port = (localStorage.getItem("openwork.server.port") || "").trim();
    const token = (localStorage.getItem("openwork.server.token") || "").trim();
    const hostToken = (localStorage.getItem("openwork.server.hostToken") || "").trim();
    const base = (urlOverride || active || (port ? "http://127.0.0.1:" + port : "")).replace(/\\/+$/, "");
    return { base, token, hostToken };
  })()`;
}

export async function ensureLocalWorkspace(ctx, folderPath, name) {
  await ctx.waitFor(`(() => { const s = ${localServerExpr()}; return Boolean(s.base && s.token); })()`, { timeoutMs: 60_000, label: "local OpenWork server URL/token" });
  let created = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    created = await ctx.eval(`(async () => {
      try {
        const s = ${localServerExpr()};
        if (!s.base || !s.token) return { ok: false, reason: "missing local server base/token", base: s.base, token: Boolean(s.token) };
        const headers = { "content-type": "application/json", authorization: "Bearer " + s.token };
        if (s.hostToken) headers["X-OpenWork-Host-Token"] = s.hostToken;
        const response = await fetch(s.base + "/workspaces/local", { method: "POST", headers, body: JSON.stringify({ folderPath: ${JSON.stringify(folderPath)}, name: ${JSON.stringify(name)}, preset: "starter" }) });
        const text = await response.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch {}
        if (!response.ok) return { ok: false, status: response.status, text };
        const workspaces = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
        const workspaceId = payload?.activeId || payload?.workspace?.id || payload?.workspaceId || workspaces.find((workspace) => workspace.path === ${JSON.stringify(folderPath)} || workspace.folderPath === ${JSON.stringify(folderPath)})?.id;
        if (!workspaceId) return { ok: false, status: response.status, text: "workspace id missing", payload };
        const activate = await fetch(s.base + "/workspaces/" + encodeURIComponent(workspaceId) + "/activate?persist=true", { method: "POST", headers });
        const activateText = await activate.text();
        if (!activate.ok) return { ok: false, status: activate.status, text: activateText };
        localStorage.setItem("openwork.react.activeWorkspace", workspaceId);
        return { ok: true, workspaceId, base: s.base };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    })()`, { awaitPromise: true });
    if (created?.ok && created.workspaceId) break;
    await sleep(1_000);
  }
  ctx.assert(created?.ok && created.workspaceId, `Workspace setup failed for ${folderPath}: ${JSON.stringify(created)}`);
  await ctx.navigateHash(`/workspace/${created.workspaceId}/session`);
  await ctx.waitFor("window.location.hash.includes('/workspace/') && window.location.hash.includes('/session')", { timeoutMs: 60_000, label: "workspace session route" });
  return created.workspaceId;
}

async function runtimeCloudControl(ctx, workspaceId) {
  return ctx.eval(`(async () => {
    const s = ${localServerExpr()};
    if (!s.base || !s.token) return { ok: false, reason: "missing local server base/token" };
    const headers = { authorization: "Bearer " + s.token };
    if (s.hostToken) headers["X-OpenWork-Host-Token"] = s.hostToken;
    const response = await fetch(s.base + "/workspace/" + ${JSON.stringify(workspaceId)} + "/mcp", { headers });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) return { ok: false, status: response.status, text };
    const items = payload?.items ?? [];
    const entry = items.find((item) => item.name === "openwork-cloud");
    return { ok: Boolean(entry?.config?.url?.includes("/mcp/agent") && entry?.config?.headers?.Authorization && entry?.config?.oauth === false && payload?.engineSync?.status === "ok"), names: items.map((item) => item.name), engineSync: payload?.engineSync?.status ?? null, failures: payload?.engineSync?.failures ?? [] };
  })()`, { awaitPromise: true });
}

export async function waitForRuntimeCloudControlMcp(ctx, workspaceId, timeout = 90_000) {
  let last = null;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      last = await runtimeCloudControl(ctx, workspaceId);
      if (last?.ok) return last;
    } catch (error) {
      last = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(1_000);
  }
  throw new Error(`OpenWork Cloud Control MCP did not become runtime-ready: ${JSON.stringify(last)}`);
}

export async function ensureOpenWorkCloudControlReady(ctx, workspaceId) {
  await ctx.navigateHash(`/workspace/${workspaceId}/settings/extensions/mcp`);
  await ctx.waitFor("document.body.innerText.includes('OpenWork Cloud Control') || document.body.innerText.includes('Add Custom App') || document.body.innerText.includes('Extension')", { timeoutMs: 60_000, label: "MCP settings mounted" });
  await clickExactIfVisible(ctx, "Show hidden", "button, [role=button]").catch(() => false);
  const connected = await ctx.eval(`(() => {
    const card = [...document.querySelectorAll("button, [role=button]")].find((entry) => (entry.textContent ?? "").includes("OpenWork Cloud Control"));
    return Boolean(card?.textContent?.includes("Connected"));
  })()`);
  if (!connected) {
    const opened = await ctx.eval(`(() => {
      const card = [...document.querySelectorAll("button, [role=button]")].find((entry) => (entry.textContent ?? "").includes("OpenWork Cloud Control"));
      card?.scrollIntoView({ block: "center", inline: "center" });
      card?.click();
      return Boolean(card);
    })()`);
    ctx.assert(opened, "Could not find the OpenWork Cloud Control MCP card in settings.");
    await ctx.waitForText("OpenWork Cloud Control", { timeoutMs: 15_000 });
    await ctx.eval(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const button = [...(dialog?.querySelectorAll("button") ?? [])].find((entry) => (entry.textContent ?? "").replace(/\\s+/g, " ").trim() === "Connect" && !entry.disabled);
      button?.click();
      return true;
    })()`);
  }
  await clickExactIfVisible(ctx, "Refresh", "button, [role=button]").catch(() => false);
  await waitForRuntimeCloudControlMcp(ctx, workspaceId);
  await ctx.navigateHash(`/workspace/${workspaceId}/session`);
  await ensureComposerReady(ctx);
}

export async function ensureComposerReady(ctx) {
  await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}))`, { timeoutMs: 60_000, label: "Lexical composer" });
  await ctx.waitFor("document.body.innerText.includes('Run task')", { timeoutMs: 60_000, label: "Run task button" });
}

export async function readTranscriptSnapshot(ctx) {
  return ctx.eval(`(async () => {
    const bodyText = document.body.innerText || "";
    let transcript = null;
    try {
      const result = await window.__openworkControl?.execute?.("session.read_transcript", { count: 30 });
      if (result?.ok && result.result?.messages) transcript = result.result;
    } catch {}
    const messages = transcript?.messages ?? [];
    const text = messages.length ? messages.map((message) => String(message.role || "") + ": " + String(message.text || "")).join("\n\n") : bodyText;
    const assistantTexts = messages.filter((message) => message.role !== "user").map((message) => String(message.text || ""));
    return { bodyText, text, messages, length: text.length, messageCount: transcript?.messageCount ?? messages.length, ready: bodyText.includes("Ready for new tasks"), stop: [...document.querySelectorAll("button")].some((button) => (button.textContent ?? "").trim() === "Stop"), latestAssistantText: assistantTexts.at(-1) || "" };
  })()`, { awaitPromise: true });
}

function hasAssistantAfter(snapshot, initialMessageCount) {
  return (snapshot.messages ?? []).some((message) => (
    typeof message.index === "number"
    && message.index >= initialMessageCount
    && message.role !== "user"
    && String(message.text ?? "").trim().length > 0
  ));
}

async function insertPromptWithExecCommand(ctx, prompt) {
  const result = await ctx.eval(`(() => {
    const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    if (!editor) return { ok: false, reason: "composer not found" };
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("insertText", false, ${JSON.stringify(prompt)});
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(prompt)} }));
    return { ok: (editor.innerText || editor.textContent || "").includes(${JSON.stringify(prompt.slice(0, 32))}), text: editor.innerText || editor.textContent || "" };
  })()`);
  ctx.assert(result?.ok, `Failed to insert prompt into Lexical composer with document.execCommand('insertText'): ${JSON.stringify(result)}`);
}

export async function sendPromptAndWait(ctx, prompt, { timeout = 300_000 } = {}) {
  await ensureComposerReady(ctx);
  const before = await readTranscriptSnapshot(ctx).catch(() => ({ messageCount: 0, length: 0 }));
  await insertPromptWithExecCommand(ctx, prompt);
  await clickExactText(ctx, "Run task", "button", 30_000);
  let last = null;
  let lastLength = -1;
  let stableTicks = 0;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    last = await readTranscriptSnapshot(ctx);
    if (last.length === lastLength) stableTicks += 1;
    else stableTicks = 0;
    lastLength = last.length;
    if (last.ready && !last.stop && hasAssistantAfter(last, before.messageCount ?? 0) && stableTicks >= 4) {
      await ctx.control("session.scroll_bottom").catch(() => undefined);
      await sleep(500);
      return last.text;
    }
    await sleep(750);
  }
  throw new Error(`Task did not complete and quiesce before timeout. Last snapshot: ${JSON.stringify(last).slice(0, 1_500)}`);
}

function authNeeded(text) {
  return /Authorization required|\/login\?|\blogin\b/i.test(text);
}

function extractLoginUrl(text) {
  const match = text.match(/https?:\/\/[^\s"'<>]+\/login\?user=[^\s"'<>]+/i);
  if (!match) return "";
  const cleaned = match[0].replace(/[)\].,;]+$/, "");
  try {
    return new URL(cleaned).toString();
  } catch {
    return "";
  }
}

export async function completeGatewayLogin(ctx, email, transcript, gatewayUserEnvName) {
  const fromTranscript = extractLoginUrl(transcript);
  const gatewayBase = cleanBase(envText(ctx, "OPENWORK_EVAL_BLUE_YONDER_GATEWAY_URL"));
  let loginUrl = fromTranscript;
  if (!loginUrl && gatewayBase) {
    const url = new URL("/login", gatewayBase);
    url.searchParams.set("user", envText(ctx, gatewayUserEnvName) || email);
    loginUrl = url.toString();
  }
  ctx.assert(Boolean(loginUrl), "Gateway requested login but no login URL was visible. Set OPENWORK_EVAL_BLUE_YONDER_GATEWAY_URL or expose the gateway login link in the transcript.");
  const response = await fetch(loginUrl);
  const text = await response.text().catch(() => "");
  ctx.assert(response.status < 400, `Gateway login failed at ${loginUrl}: ${response.status} ${text.slice(0, 300)}`);
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion: `Gateway login completed for ${email}`, actual: loginUrl.replace(/user=[^&]+/, "user=<redacted>") });
}

export async function retryAfterGatewayLoginIfNeeded(ctx, email, transcript, expectedText, retryPrompt, options = {}) {
  if (transcript.includes(expectedText) || !authNeeded(transcript)) return transcript;
  await completeGatewayLogin(ctx, email, transcript, options.gatewayUserEnvName ?? "OPENWORK_EVAL_BLUE_YONDER_GATEWAY_USER");
  return sendPromptAndWait(ctx, retryPrompt, { timeout: options.timeout ?? 300_000 });
}

export async function listSkillsFor(ctx, token) {
  const result = await denApiFetch(ctx, "/v1/skills", { headers: { authorization: `Bearer ${token}` } });
  ctx.assert(result.response.ok, `GET /v1/skills failed: ${result.response.status} ${result.text.slice(0, 400)}`);
  return result.body?.skills ?? [];
}
