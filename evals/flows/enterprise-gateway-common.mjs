const CLICKABLE_SELECTOR = "button, [role=button], a, div, article, li, label";
const EDITOR_SELECTOR = '[contenteditable="true"][data-lexical-editor="true"]';
const WELCOME_FOLDER_INPUT_SELECTOR = 'input[placeholder="/workspace/my-project"]';
const DEFAULT_PASSWORD = "TutorialDemo123!";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function envText(ctx, name) {
  return (ctx.env[name] ?? "").trim();
}

export function enterpriseOrgName(ctx) {
  return envText(ctx, "OPENWORK_EVAL_ENTERPRISE_ORG_NAME") || "Example Organization";
}

export function cleanBase(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

export function denApiBase(ctx) {
  const value = cleanBase(envText(ctx, "OPENWORK_EVAL_DEN_API_URL"));
  ctx.assert(Boolean(value), "Missing OPENWORK_EVAL_DEN_API_URL for the enterprise eval flow.");
  return value;
}

export function denWebBase(ctx) {
  const value = cleanBase(envText(ctx, "OPENWORK_EVAL_DEN_WEB_URL"));
  ctx.assert(Boolean(value), "Missing OPENWORK_EVAL_DEN_WEB_URL for the enterprise desktop handoff deep link.");
  return value;
}

export function workspaceFolder(ctx, envName, fallback) {
  return envText(ctx, envName) || fallback;
}

export function timeoutMs(ctx, envName, fallback) {
  const raw = envText(ctx, envName) || envText(ctx, "OPENWORK_EVAL_ENTERPRISE_TASK_TIMEOUT_MS");
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
    body: JSON.stringify({ email, password: envText(ctx, "OPENWORK_EVAL_ENTERPRISE_PASSWORD") || DEFAULT_PASSWORD }),
  });
  ctx.assert(result.response.ok, httpFailureMessage(`Enterprise sign-in failed for ${email}`, result));
  const token = result.body?.token;
  ctx.assert(typeof token === "string" && token.trim().length > 0, `Enterprise sign-in for ${email} returned no bearer token.`);
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
    window.__enterpriseHandoffDiagnostics = { events: [], exchanges: [] };
    window.addEventListener("openwork-den-session-updated", (event) => {
      const detail = event.detail ?? null;
      window.__enterpriseHandoffDiagnostics.events.push(detail?.token ? { ...detail, token: "<redacted>" } : detail);
    });
    if (!window.__enterpriseFetchWrapped) {
      window.__enterpriseFetchWrapped = true;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const requestUrl = typeof args[0] === "string" ? args[0] : args[0] instanceof URL ? args[0].toString() : args[0]?.url;
        if (typeof requestUrl === "string" && requestUrl.includes("/v1/auth/desktop-handoff/exchange")) {
          response.clone().text().then((text) => {
            window.__enterpriseHandoffDiagnostics.exchanges.push({ status: response.status, statusText: response.statusText, url: requestUrl, body: redact(text).slice(0, 1_000) });
          }).catch((error) => {
            window.__enterpriseHandoffDiagnostics.exchanges.push({ status: response.status, statusText: response.statusText, url: requestUrl, body: error instanceof Error ? error.message : String(error) });
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
      events: window.__enterpriseHandoffDiagnostics?.events ?? [],
      exchanges: window.__enterpriseHandoffDiagnostics?.exchanges ?? [],
    }))()`);
    const redactedUrl = openworkUrl.replace(/([?&]grant=)[^&]+/, "$1<redacted>");
    throw new Error(`Timed out waiting for desktop Den token after deep-link handoff ${redactedUrl}. Diagnostics: ${JSON.stringify(diagnostics)}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function clickExactText(ctx, text, selector = "button, [role=button], a", timeout = 20_000) {
  await ctx.waitFor(`(() => {
    const normalize = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
    const visibleEnabled = (entry) => {
      entry.scrollIntoView({ block: "center", inline: "center" });
      const rect = entry.getBoundingClientRect();
      const style = window.getComputedStyle(entry);
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return entry.disabled !== true
        && entry.getAttribute("aria-disabled") !== "true"
        && rect.width > 0
        && rect.height > 0
        && style.visibility !== "hidden"
        && style.display !== "none"
        && Boolean(top && (top === entry || entry.contains(top)));
    };
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((entry) => normalize(entry.textContent) === ${JSON.stringify(text)} && visibleEnabled(entry));
    element?.scrollIntoView({ block: "center", inline: "center" });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: timeout, label: `exact clickable text ${JSON.stringify(text)}` });
}

export async function clickExactIfVisible(ctx, text, selector = "button, [role=button], a") {
  return Boolean(await ctx.eval(`(() => {
    const normalize = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
    const visibleEnabled = (entry) => {
      entry.scrollIntoView({ block: "center", inline: "center" });
      const rect = entry.getBoundingClientRect();
      const style = window.getComputedStyle(entry);
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return entry.disabled !== true
        && entry.getAttribute("aria-disabled") !== "true"
        && rect.width > 0
        && rect.height > 0
        && style.visibility !== "hidden"
        && style.display !== "none"
        && Boolean(top && (top === entry || entry.contains(top)));
    };
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((entry) => normalize(entry.textContent) === ${JSON.stringify(text)} && visibleEnabled(entry));
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

export async function completeEnterpriseOrgOnboarding(ctx) {
  const orgName = enterpriseOrgName(ctx);
  const deadline = Date.now() + 90_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await ctx.eval(`(() => {
      const orgName = ${JSON.stringify(orgName)};
      const text = document.body.innerText || "";
      const buttons = [...document.querySelectorAll("button, [role=button]")].map((entry) => (entry.textContent ?? "").replace(/\\s+/g, " ").trim());
      return {
        hash: window.location.hash,
        activeOrgName: localStorage.getItem("openwork.den.activeOrgName") || "",
        hasChoose: text.includes("Choose your organization"),
        hasOrgName: text.includes(orgName),
        hasContinueOrg: buttons.some((button) => button.startsWith("Continue with organization")),
        hasContinueWorkspace: buttons.includes("Continue to workspace"),
        hasFolderInput: Boolean(document.querySelector('input[placeholder="/workspace/my-project"]')),
      };
    })()`);
    if (last.hasFolderInput || last.hash.includes("/welcome")) return;
    if (last.activeOrgName === orgName && !last.hasChoose && !last.hasContinueOrg && !last.hasContinueWorkspace) return;
    const onboardingClick = await clickThroughLingeringOnboarding(ctx);
    if (onboardingClick.clickedContinueOrg || onboardingClick.clickedContinueWorkspace) {
      await sleep(1_000);
      continue;
    }
    if (last.hasChoose && last.hasOrgName && await clickNearestExactIfVisible(ctx, orgName)) {
      await sleep(750);
      continue;
    }
    if (last.activeOrgName === orgName) return;
    await sleep(750);
  }
  throw new Error(`Enterprise org onboarding did not settle: ${JSON.stringify(last)}`);
}

export async function desktopHandoffSignIn(ctx, email) {
  await configureDesktopForDen(ctx);
  await resetDesktopDenSession(ctx);
  const token = await signInByEmail(ctx, email);
  const openworkUrl = await createDesktopHandoff(ctx, token);
  await deliverDesktopDeepLink(ctx, openworkUrl);
  await waitForDesktopDenToken(ctx, openworkUrl);
  await completeEnterpriseOrgOnboarding(ctx);
  await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.activeOrgId') ?? '').trim())", { timeoutMs: 60_000, label: "desktop active organization" });
  return token;
}

function localServerExpr() {
  return `(() => {
    const urlOverride = (localStorage.getItem("openwork.server.urlOverride") || "").trim();
    const port = (localStorage.getItem("openwork.server.port") || "").trim();
    const token = (localStorage.getItem("openwork.server.token") || "").trim();
    const hostToken = (localStorage.getItem("openwork.server.hostToken") || "").trim();
    const base = urlOverride.replace(/\\/+$/, "") || (port ? "http://127.0.0.1:" + port : "");
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
  const existing = await workspaceSessionState(ctx);
  if (existing.hasConcreteSession) {
    await clickThroughWorkspaceOnboarding(ctx, folderPath);
    await ensureComposerReady(ctx);
    const ready = await workspaceSessionState(ctx);
    ctx.assert(Boolean(ready.workspaceId), `Existing workspace route lost its workspace id before Connect polling: ${JSON.stringify(ready)}`);
    return ready.workspaceId;
  }
  return ensureLocalWorkspace(ctx, folderPath);
}

export async function ensureLocalWorkspace(ctx, folderPath) {
  await ctx.waitFor(`(() => { const s = ${localServerExpr()}; return Boolean(s.base && s.token); })()`, { timeoutMs: 60_000, label: "local OpenWork server URL/token" });
  let last = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await clickThroughWorkspaceOnboarding(ctx, folderPath);
    last = await workspaceSessionState(ctx);
    if (last.hasConcreteSession) {
      await ensureComposerReady(ctx);
      const ready = await workspaceSessionState(ctx);
      ctx.assert(Boolean(ready.workspaceId), `Workspace route did not include a workspace id after onboarding: ${JSON.stringify(ready)}`);
      return ready.workspaceId;
    }
    if (!last.hasFolderInput && !last.hasWelcome) {
      await ctx.eval(`(() => { window.location.hash = "#/welcome"; return window.location.hash; })()`);
    }
    await sleep(1_000);
  }
  throw new Error(`Workspace setup through the visible welcome flow did not reach /workspace/<id>/session/ses_* for ${folderPath}. Last state: ${JSON.stringify(last)}`);
}

async function clickThroughWorkspaceOnboarding(ctx, folderPath) {
  const onboardingClick = await clickThroughLingeringOnboarding(ctx);
  if (onboardingClick.clickedContinueOrg || onboardingClick.clickedContinueWorkspace) return true;
  for (const text of ["Skip and use the free model", "Continue without OpenWork Models", "Skip"]) {
    if (await clickExactIfVisible(ctx, text, "button, [role=button]")) return true;
  }
  const state = await workspaceSessionState(ctx);
  if (state.hasFolderInput) {
    if (!folderPath || state.workspaceCreateBusy) return false;
    await ctx.fill(WELCOME_FOLDER_INPUT_SELECTOR, folderPath);
    return clickExactIfVisible(ctx, "Use this folder", "button");
  }
  return false;
}

async function workspaceSessionState(ctx) {
  return ctx.eval(`(() => {
    const hash = window.location.hash;
    const match = hash.match(/^#\\/workspace\\/([^/?#]+)\\/session\\/(ses_[^/?#]+)/);
    const decode = (value) => {
      try { return decodeURIComponent(value); } catch { return value; }
    };
    const text = document.body.innerText || "";
    const input = document.querySelector(${JSON.stringify(WELCOME_FOLDER_INPUT_SELECTOR)});
    const inputRect = input?.getBoundingClientRect();
    return {
      hash,
      workspaceId: match ? decode(match[1]) : "",
      sessionId: match ? decode(match[2]) : "",
      hasConcreteSession: Boolean(match),
      hasComposer: Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})),
      hasFolderInput: Boolean(input && inputRect && inputRect.width > 0 && inputRect.height > 0),
      hasWelcome: text.includes("Welcome to OpenWork"),
      workspaceCreateBusy: text.includes("Creating workspace"),
      hasConnectStatus: /OpenWork Connect: (Ready|Checking|Needs attention)/.test(text),
      opencodeUnavailable: text.includes("OpenCode unavailable") || text.includes("opencode_unconfigured") || text.includes("OpenCode base URL is missing"),
      text: text.slice(0, 1_000),
    };
  })()`);
}

export async function ensureComposerReady(ctx, timeout = 90_000) {
  let last = null;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await clickThroughWorkspaceOnboarding(ctx, "");
    last = await workspaceSessionState(ctx);
    if (last?.hasConcreteSession && last.hasComposer && !last.opencodeUnavailable) break;
    await sleep(1_000);
  }
  if (last?.opencodeUnavailable) throw new Error(`OpenCode unavailable — the workspace OpenCode base URL is still missing while waiting for the composer. Restart the app and rerun this eval so the welcome flow can spawn the managed engine. Last state: ${JSON.stringify(last)}`);
  if (!last?.hasConcreteSession) throw new Error(`Workspace did not reach a concrete /workspace/<id>/session/ses_* route within ${timeout}ms: ${JSON.stringify(last)}`);
  if (!last?.hasComposer) throw new Error(`Workspace composer did not become ready within ${timeout}ms: ${JSON.stringify(last)}`);
  await ctx.waitFor("document.body.innerText.includes('Run task')", { timeoutMs: 60_000, label: "Run task button" });
}

export async function readTranscriptSnapshot(ctx) {
  return ctx.eval(`(async () => {
    const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    const substantive = (value) => {
      const text = normalize(value);
      return text.length > 0 && text !== "OpenWork";
    };
    const bodyText = document.body.innerText || "";
    let transcript = null;
    try {
      const result = await window.__openworkControl?.execute?.("session.read_transcript", { count: 30 });
      if (result?.ok && result.result?.messages) transcript = result.result;
    } catch {}
    const messages = transcript?.messages ?? [];
    const transcriptText = messages.length ? messages.map((message) => String(message.role || "") + ": " + String(message.text || "")).join("\\n\\n") : "";
    const markdownTexts = [...document.querySelectorAll(".markdown-content")]
      .map((element) => element.innerText || element.textContent || "")
      .filter((value) => normalize(value).length > 0);
    const latestRenderedMarkdown = markdownTexts.at(-1) || "";
    const textParts = transcriptText ? [transcriptText] : [];
    if (latestRenderedMarkdown && !normalize(transcriptText).includes(normalize(latestRenderedMarkdown))) textParts.push(latestRenderedMarkdown);
    const text = textParts.join("\\n\\n") || bodyText;
    const activeLabels = ["Thinking", "Responding", "Waiting", "Compacting", "Session streaming", "Session active"];
    const activityLabels = [...document.querySelectorAll("[aria-label]")]
      .map((element) => element.getAttribute("aria-label") || "")
      .filter((label) => activeLabels.includes(label));
    const assistantTexts = messages.filter((message) => message.role !== "user").map((message) => String(message.text || ""));
    const substantiveAssistantTexts = assistantTexts.filter((value) => substantive(value));
    return { bodyText, transcriptText, text, messages, length: text.length, messageCount: transcript?.messageCount ?? messages.length, ready: bodyText.includes("Ready for new tasks"), stop: [...document.querySelectorAll("button")].some((button) => (button.textContent ?? "").trim() === "Stop"), activityActive: activityLabels.length > 0, activityLabels, latestRenderedMarkdown, latestAssistantText: latestRenderedMarkdown || substantiveAssistantTexts.at(-1) || "" };
  })()`, { awaitPromise: true });
}

function normalizeSnapshotText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isSubstantiveAssistantText(value) {
  const text = normalizeSnapshotText(value);
  return text.length > 0 && text !== "OpenWork";
}

function hasAssistantAfter(snapshot, initialMessageCount) {
  const start = typeof initialMessageCount === "number" ? initialMessageCount : 0;
  return (snapshot.messages ?? []).some((message, index) => {
    const messageIndex = typeof message.index === "number" ? message.index : index;
    return messageIndex >= start
      && message.role !== "user"
      && isSubstantiveAssistantText(message.text);
  });
}

function snapshotChangedAfterSubmit(snapshot, before) {
  const beforeMessageCount = before.messageCount ?? 0;
  return (snapshot.messageCount ?? 0) > beforeMessageCount
    || normalizeSnapshotText(snapshot.transcriptText) !== normalizeSnapshotText(before.transcriptText)
    || normalizeSnapshotText(snapshot.latestRenderedMarkdown) !== normalizeSnapshotText(before.latestRenderedMarkdown);
}

function hasSubstantivePostSubmitOutput(snapshot, before) {
  return hasAssistantAfter(snapshot, before.messageCount ?? 0)
    || (
      isSubstantiveAssistantText(snapshot.latestRenderedMarkdown)
      && normalizeSnapshotText(snapshot.latestRenderedMarkdown) !== normalizeSnapshotText(before.latestRenderedMarkdown)
    );
}

function snapshotSignature(snapshot) {
  return [
    snapshot.messageCount ?? 0,
    normalizeSnapshotText(snapshot.transcriptText),
    normalizeSnapshotText(snapshot.latestRenderedMarkdown),
    snapshot.activityActive ? "active" : "idle",
    snapshot.stop ? "stop" : "run",
  ].join("|");
}

async function insertPromptWithSyntheticPaste(ctx, prompt) {
  const result = await ctx.eval(`(async () => {
    const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    if (!editor) return { ok: false, reason: "composer not found" };
    const prompt = ${JSON.stringify(prompt)};
    const normalize = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
    const readText = () => editor.innerText || editor.textContent || "";
    const visiblePastedChips = () => [...document.querySelectorAll("button[data-pasted-expand-label]")]
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        return rect.width > 0
          && rect.height > 0
          && style.visibility !== "hidden"
          && style.display !== "none"
          && button.disabled !== true;
      })
      .map((button) => ({
        label: button.dataset.pastedExpandLabel || "",
        text: normalize(button.closest("span")?.textContent || button.textContent || ""),
        ariaLabel: button.getAttribute("aria-label") || "",
      }));
    const selectEditorContents = () => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    editor.focus();
    const before = readText();
    const initialChips = visiblePastedChips();
    if (normalize(before) || initialChips.length > 0) {
      selectEditorContents();
      const selectAll = { bubbles: true, cancelable: true, key: "a", code: "KeyA", metaKey: navigator.platform.includes("Mac"), ctrlKey: !navigator.platform.includes("Mac") };
      editor.dispatchEvent(new KeyboardEvent("keydown", selectAll));
      editor.dispatchEvent(new KeyboardEvent("keyup", selectAll));
      const deleteKey = { bubbles: true, cancelable: true, key: "Backspace", code: "Backspace" };
      editor.dispatchEvent(new KeyboardEvent("keydown", deleteKey));
      editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward", data: null }));
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      editor.dispatchEvent(new KeyboardEvent("keyup", deleteKey));
      await waitFrame();
    }
    const chipsBefore = visiblePastedChips();
    selectEditorContents();
    const data = new DataTransfer();
    data.setData("text/plain", prompt);
    const accepted = editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    await waitFrame();
    await waitFrame();
    const text = readText();
    const chipsAfter = visiblePastedChips();
    const inlineMatched = normalize(text).includes(normalize(prompt));
    const newPastedChip = chipsAfter.length > chipsBefore.length;
    return {
      ok: inlineMatched || newPastedChip,
      representation: inlineMatched ? "inline" : newPastedChip ? "pasted-chip" : "missing",
      inlineMatched,
      newPastedChip,
      text: text.slice(0, 1_000),
      before: before.slice(0, 1_000),
      accepted,
      chipCountBefore: chipsBefore.length,
      chipCountAfter: chipsAfter.length,
      chipLabelsBefore: chipsBefore.map((chip) => chip.text || chip.ariaLabel || chip.label),
      chipLabelsAfter: chipsAfter.map((chip) => chip.text || chip.ariaLabel || chip.label),
    };
  })()`, { awaitPromise: true });
  ctx.assert(result?.ok, `Failed to paste prompt into Lexical composer with synthetic ClipboardEvent('paste'): ${JSON.stringify(result)}`);
}

export async function sendPromptAndWait(ctx, prompt, { timeout = 300_000 } = {}) {
  await ensureComposerReady(ctx);
  const before = await readTranscriptSnapshot(ctx).catch(() => ({ messageCount: 0, length: 0 }));
  await insertPromptWithSyntheticPaste(ctx, prompt);
  await clickExactText(ctx, "Run task", "button", 30_000);
  let last = null;
  let lastSignature = "";
  let stableTicks = 0;
  let transitionSeen = false;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    last = await readTranscriptSnapshot(ctx);
    const changed = snapshotChangedAfterSubmit(last, before);
    if (last.activityActive || changed) transitionSeen = true;
    const signature = snapshotSignature(last);
    if (signature === lastSignature && !last.activityActive) stableTicks += 1;
    else stableTicks = 0;
    lastSignature = signature;
    if (transitionSeen && !last.activityActive && !last.stop && hasSubstantivePostSubmitOutput(last, before) && stableTicks >= 4) {
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

function normalizeGatewayPrincipal(value) {
  const normalized = value.trim().toLowerCase();
  const at = normalized.indexOf("@");
  return at > 0 ? normalized.slice(0, at) : normalized;
}

function gatewayLoginUrl(ctx, transcript, desiredUser) {
  const principal = normalizeGatewayPrincipal(desiredUser);
  const fromTranscript = extractLoginUrl(transcript);
  const gatewayBase = cleanBase(envText(ctx, "OPENWORK_EVAL_ENTERPRISE_GATEWAY_URL"));
  let loginUrl = fromTranscript;
  try {
    if (!loginUrl && gatewayBase) loginUrl = new URL("/login", gatewayBase).toString();
  } catch {
    return "";
  }
  if (!loginUrl) return "";
  try {
    const url = new URL(loginUrl);
    url.searchParams.set("user", principal);
    return url.toString();
  } catch {
    return "";
  }
}

export async function completeGatewayLogin(ctx, email, transcript, gatewayUserEnvName) {
  const desiredUser = normalizeGatewayPrincipal(envText(ctx, gatewayUserEnvName) || email);
  const loginUrl = gatewayLoginUrl(ctx, transcript, desiredUser);
  ctx.assert(Boolean(loginUrl), "Gateway requested login but no login URL was visible. Set OPENWORK_EVAL_ENTERPRISE_GATEWAY_URL or expose the gateway login link in the transcript.");
  const response = await fetch(loginUrl);
  const text = await response.text().catch(() => "");
  ctx.assert(response.status < 400, `Gateway login failed at ${loginUrl}: ${response.status} ${text.slice(0, 300)}`);
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion: `Gateway login completed for ${desiredUser}`, actual: loginUrl.replace(/user=[^&]+/, "user=<redacted>") });
}

export async function retryAfterGatewayLoginIfNeeded(ctx, email, transcript, expectedText, retryPrompt, options = {}) {
  if (transcript.includes(expectedText)) return transcript;
  const gatewayUserEnvName = options.gatewayUserEnvName ?? "OPENWORK_EVAL_ENTERPRISE_GATEWAY_USER";
  const desiredUser = normalizeGatewayPrincipal(envText(ctx, gatewayUserEnvName) || email);
  if (!gatewayLoginUrl(ctx, transcript, desiredUser) && !authNeeded(transcript)) return transcript;
  await completeGatewayLogin(ctx, email, transcript, gatewayUserEnvName);
  return sendPromptAndWait(ctx, retryPrompt, { timeout: options.timeout ?? 300_000 });
}

export async function listSkillsFor(ctx, token) {
  const result = await denApiFetch(ctx, "/v1/skills", { headers: { authorization: `Bearer ${token}` } });
  ctx.assert(result.response.ok, httpFailureMessage("GET /v1/skills failed", result));
  return result.body?.skills ?? [];
}
