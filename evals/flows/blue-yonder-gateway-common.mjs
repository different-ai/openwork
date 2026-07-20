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
  const value = cleanBase(envText(ctx, "OPENWORK_EVAL_DEN_WEB_URL"));
  ctx.assert(Boolean(value), "Missing OPENWORK_EVAL_DEN_WEB_URL for the Blue Yonder desktop handoff deep link.");
  return value;
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
  const url = `${denApiBase(ctx)}${pathname}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      Origin: denWebBase(ctx),
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
  return { response, body, text, url };
}

function httpFailureMessage(label, result) {
  return `${label}: ${result.response.status} ${result.response.statusText} ${result.text.slice(0, 1_000)} (url: ${result.url})`;
}

export async function signInByEmail(ctx, email) {
  const result = await denApiFetch(ctx, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password: envText(ctx, "OPENWORK_EVAL_BLUE_YONDER_PASSWORD") || DEFAULT_PASSWORD }),
  });
  ctx.assert(result.response.ok, httpFailureMessage(`Blue Yonder sign-in failed for ${email}`, result));
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
  ctx.assert(result.response.ok, httpFailureMessage("Desktop handoff create failed", result));
  const openworkUrl = result.body?.openworkUrl;
  ctx.assert(typeof openworkUrl === "string" && openworkUrl.length > 0, "Desktop handoff response did not include openworkUrl.");
  const url = new URL(openworkUrl);
  url.searchParams.set("denBaseUrl", denWebBase(ctx));
  return url.toString();
}

export async function configureDesktopForDen(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 120_000, label: "OpenWork control API" });
  const apiBase = denApiBase(ctx);
  const webBase = denWebBase(ctx);
  const result = await ctx.eval(`(async () => {
    const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (bridge) {
      await bridge("setDesktopBootstrapConfig", { baseUrl: ${JSON.stringify(webBase)}, apiBaseUrl: ${JSON.stringify(apiBase)}, requireSignin: false, handoff: null });
    }
    localStorage.setItem("openwork.den.baseUrl", ${JSON.stringify(webBase)});
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
  const webBase = denWebBase(ctx);
  await ctx.eval(`(() => {
    const url = ${JSON.stringify(openworkUrl)};
    const redact = (value) => String(value ?? "")
      .replace(/("token"\\s*:\\s*")[^"]+/gi, "$1<redacted>")
      .replace(/Bearer\\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>");
    window.__blueYonderHandoffDiagnostics = { events: [], exchanges: [] };
    window.addEventListener("openwork-den-session-updated", (event) => {
      const detail = event.detail ?? null;
      window.__blueYonderHandoffDiagnostics.events.push(detail?.token ? { ...detail, token: "<redacted>" } : detail);
    });
    if (!window.__blueYonderFetchWrapped) {
      window.__blueYonderFetchWrapped = true;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const requestUrl = typeof args[0] === "string" ? args[0] : args[0] instanceof URL ? args[0].toString() : args[0]?.url;
        if (typeof requestUrl === "string" && requestUrl.includes("/v1/auth/desktop-handoff/exchange")) {
          response.clone().text().then((text) => {
            window.__blueYonderHandoffDiagnostics.exchanges.push({ status: response.status, statusText: response.statusText, url: requestUrl, body: redact(text).slice(0, 1_000) });
          }).catch((error) => {
            window.__blueYonderHandoffDiagnostics.exchanges.push({ status: response.status, statusText: response.statusText, url: requestUrl, body: error instanceof Error ? error.message : String(error) });
          });
        }
        return response;
      };
    }
    window.__OPENWORK__ = window.__OPENWORK__ || {};
    window.__OPENWORK__.deepLinks = [...(window.__OPENWORK__.deepLinks || []), url];
    window.dispatchEvent(new CustomEvent("openwork:deep-link", { detail: { urls: [url], denBaseUrl: ${JSON.stringify(webBase)} } }));
    return true;
  })()`);
}

async function waitForDesktopDenToken(ctx, openworkUrl) {
  try {
    await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", { timeoutMs: 60_000, label: "desktop Den token" });
  } catch (error) {
    const diagnostics = await ctx.eval(`(() => ({
      authToken: Boolean((localStorage.getItem("openwork.den.authToken") ?? "").trim()),
      baseUrl: localStorage.getItem("openwork.den.baseUrl") || "",
      apiBaseUrl: localStorage.getItem("openwork.den.apiBaseUrl") || "",
      activeOrgId: localStorage.getItem("openwork.den.activeOrgId") || "",
      events: window.__blueYonderHandoffDiagnostics?.events ?? [],
      exchanges: window.__blueYonderHandoffDiagnostics?.exchanges ?? [],
    }))()`);
    const redactedUrl = openworkUrl.replace(/([?&]grant=)[^&]+/, "$1<redacted>");
    throw new Error(`Timed out waiting for desktop Den token after deep-link handoff ${redactedUrl}. Diagnostics: ${JSON.stringify(diagnostics)}. ${error instanceof Error ? error.message : String(error)}`);
  }
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

export async function clickThroughLingeringOnboarding(ctx) {
  return ctx.eval(`(() => {
    const normalize = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
    const click = (element) => {
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return true;
    };
    const findButton = (predicate) => [...document.querySelectorAll("button, [role=button]")]
      .find((entry) => predicate(normalize(entry.textContent)) && entry.disabled !== true && entry.getAttribute("aria-disabled") !== "true");
    const continueOrg = findButton((text) => text.startsWith("Continue with organization"));
    const clickedContinueOrg = continueOrg ? click(continueOrg) : false;
    const continueWorkspace = findButton((text) => text === "Continue to workspace");
    const clickedContinueWorkspace = continueWorkspace ? click(continueWorkspace) : false;
    return {
      hash: window.location.hash,
      hasContinueOrg: Boolean(continueOrg),
      hasContinueWorkspace: Boolean(continueWorkspace),
      clickedContinueOrg,
      clickedContinueWorkspace,
    };
  })()`);
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
        hasContinueOrg: buttons.some((button) => button.startsWith("Continue with organization")),
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
    const onboardingClick = await clickThroughLingeringOnboarding(ctx);
    if (onboardingClick.clickedContinueOrg || onboardingClick.clickedContinueWorkspace) {
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
  await waitForDesktopDenToken(ctx, openworkUrl);
  await completeBlueYonderOrgOnboarding(ctx);
  await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.activeOrgId') ?? '').trim())", { timeoutMs: 60_000, label: "desktop active organization" });
  return token;
}

function localServerExpr() {
  return `(() => {
    const urlOverride = (localStorage.getItem("openwork.server.urlOverride") || "").trim();
    const token = (localStorage.getItem("openwork.server.token") || "").trim();
    const hostToken = (localStorage.getItem("openwork.server.hostToken") || "").trim();
    const base = urlOverride.replace(/\\/+$/, "");
    return { base, token, hostToken };
  })()`;
}

export async function waitForOpenWorkConnectReady(ctx, timeout = 90_000) {
  let last = null;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const onboardingClick = await clickThroughLingeringOnboarding(ctx);
    if (onboardingClick.clickedContinueOrg || onboardingClick.clickedContinueWorkspace) await sleep(1_000);
    last = await ctx.eval(`(() => {
      const text = document.body.innerText || "";
      const match = text.match(/OpenWork Connect: (Ready|Checking|Needs attention)/);
      return { ready: text.includes("OpenWork Connect: Ready"), status: match?.[0] || "", hash: window.location.hash };
    })()`);
    if ((last.hash === "#/onboarding" || last.hash === "#/welcome") && !onboardingClick.hasContinueOrg && !onboardingClick.hasContinueWorkspace) {
      await ctx.eval("window.dispatchEvent(new Event('focus'))").catch(() => undefined);
      await sleep(1_000);
      continue;
    }
    if (last?.ready) return last;
    await ctx.eval("window.dispatchEvent(new Event('focus'))").catch(() => undefined);
    await sleep(1_000);
  }
  throw new Error(`OpenWork Connect did not become Ready in the status bar within ${timeout}ms: ${JSON.stringify(last)}`);
}

export async function ensureLocalWorkspaceBeforeConnectPollIfNeeded(ctx, folderPath) {
  const route = await ctx.eval(`(() => {
    const text = document.body.innerText || "";
    const hash = window.location.hash;
    return {
      hash,
      hasConnectStatus: /OpenWork Connect: (Ready|Checking|Needs attention)/.test(text),
      hasWorkspaceRoute: hash.includes("/workspace/"),
    };
  })()`);
  if (route?.hash?.startsWith("#/welcome")) return ensureLocalWorkspace(ctx, folderPath);
  if (route?.hasConnectStatus || route?.hasWorkspaceRoute) return "";

  const probe = await ctx.eval(`(async () => {
    try {
      const s = ${localServerExpr()};
      if (!s.base || !s.token) return { ok: false, reason: "missing local server base/token" };
      const headers = { Authorization: "Bearer " + s.token };
      if (s.hostToken) headers["X-OpenWork-Host-Token"] = s.hostToken;
      const response = await fetch(s.base + "/workspaces", { headers });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch {}
      if (!response.ok) return { ok: false, status: response.status, text: text.slice(0, 1_000) };
      const workspaces = Array.isArray(payload?.workspaces) ? payload.workspaces : Array.isArray(payload?.items) ? payload.items : [];
      return { ok: true, count: workspaces.length, activeId: typeof payload?.activeId === "string" ? payload.activeId : "" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })()`, { awaitPromise: true });
  if (probe?.ok && probe.count === 0) return ensureLocalWorkspace(ctx, folderPath);
  return "";
}

export async function ensureLocalWorkspace(ctx, folderPath) {
  await ctx.waitFor(`(() => { const s = ${localServerExpr()}; return Boolean(s.base && s.token); })()`, { timeoutMs: 60_000, label: "local OpenWork server URL/token" });
  let created = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    created = await ctx.eval(`(async () => {
      try {
        const s = ${localServerExpr()};
        if (!s.base || !s.token) return { ok: false, reason: "missing local server base/token", base: s.base, token: Boolean(s.token) };
        const headers = { "Content-Type": "application/json", Authorization: "Bearer " + s.token };
        if (s.hostToken) headers["X-OpenWork-Host-Token"] = s.hostToken;
        const response = await fetch(s.base + "/workspaces/local", { method: "POST", headers, body: JSON.stringify({ folderPath: ${JSON.stringify(folderPath)} }) });
        const text = await response.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch {}
        if (!response.ok) return { ok: false, status: response.status, text };
        const workspaceId = typeof payload?.activeId === "string" ? payload.activeId.trim() : "";
        if (!workspaceId) return { ok: false, status: response.status, text: "workspace id missing", payload };
        localStorage.setItem("openwork.react.activeWorkspace", workspaceId);
        return { ok: true, workspaceId, base: s.base, status: response.status };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    })()`, { awaitPromise: true });
    if (created?.ok && created.workspaceId) break;
    await sleep(1_000);
  }
  ctx.assert(created?.ok && created.workspaceId, `Workspace setup failed for ${folderPath}: ${JSON.stringify(created)}`);
  await ctx.eval(`(() => {
    window.location.hash = ${JSON.stringify(`#/workspace/${created.workspaceId}/session`)};
    return window.location.hash;
  })()`);
  await ctx.waitFor("window.location.hash.includes('/workspace/') && window.location.hash.includes('/session')", { timeoutMs: 60_000, label: "workspace session route" });
  await ensureComposerReady(ctx);
  return created.workspaceId;
}

export async function ensureComposerReady(ctx, timeout = 90_000) {
  let last = null;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    last = await ctx.eval(`(() => {
      const text = document.body.innerText || "";
      return {
        hasComposer: Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})),
        opencodeUnavailable: text.includes("OpenCode unavailable") || text.includes("opencode_unconfigured"),
        hash: window.location.hash,
        text: text.slice(0, 1_000),
      };
    })()`);
    if (last?.hasComposer && !last.opencodeUnavailable) break;
    await sleep(1_000);
  }
  if (last?.opencodeUnavailable) throw new Error(`OpenCode unavailable — opencode_unconfigured persisted while waiting for the workspace composer. Restart the app and rerun this eval so the engine can spawn. Last state: ${JSON.stringify(last)}`);
  if (!last?.hasComposer) throw new Error(`Workspace composer did not become ready within ${timeout}ms: ${JSON.stringify(last)}`);
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
  ctx.assert(result.response.ok, httpFailureMessage("GET /v1/skills failed", result));
  return result.body?.skills ?? [];
}
