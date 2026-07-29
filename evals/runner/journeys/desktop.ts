import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvalError } from "../context.ts";
import { apiSignIn, denApiFetch, resolveDenApiUrl, resolveDenWebUrl, validateActor } from "./den.ts";
import type { Actor } from "../actors.ts";
import type { FlowContext } from "../flow.ts";
import type { Surface } from "../surfaces.ts";

export interface FirstBootOptions {
  surface: string | Surface;
  workspacePath?: string;
  timeoutMs?: number;
}

export interface FirstBootResult {
  workspacePath: string;
}

export interface ConnectDenOptions {
  surface: string | Surface;
  actor: Actor;
  denWebUrl?: string;
  denApiUrl?: string;
  organizationId?: string;
  organizationName?: string;
}

export interface ConnectDenResult {
  email: string;
  baseUrl: string;
  apiBaseUrl: string;
  activeOrgName?: string;
  status: "already-connected" | "connected";
}

export interface RunPromptOptions {
  surface: string | Surface;
  prompt: string;
  submit?: boolean;
  expectResponse?: boolean;
  timeoutMs?: number;
}

export interface RunPromptResult {
  sessionRoute?: string;
}

export interface OpenSettingsOptions {
  surface: string | Surface;
  section?: string;
}

export interface OpenSettingsResult {
  route: string;
}

interface DesktopDenState {
  token: string;
  baseUrl: string;
  apiBaseUrl: string;
  activeOrgName: string;
}

interface PasteResult {
  ok: boolean;
  reason?: string;
  representation?: string;
}

const DEFAULT_FIRST_BOOT_TIMEOUT_MS = 90_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 180_000;
const EDITOR_SELECTOR = '[contenteditable="true"][data-lexical-editor="true"], [contenteditable="true"]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function desktopDenStateFromUnknown(value: unknown): DesktopDenState {
  if (!isRecord(value)) return { token: "", baseUrl: "", apiBaseUrl: "", activeOrgName: "" };
  return {
    token: stringField(value, "token"),
    baseUrl: stringField(value, "baseUrl"),
    apiBaseUrl: stringField(value, "apiBaseUrl"),
    activeOrgName: stringField(value, "activeOrgName"),
  };
}

function pasteResultFromUnknown(value: unknown): PasteResult {
  if (!isRecord(value)) return { ok: false, reason: "paste result was not an object" };
  return {
    ok: value.ok === true,
    reason: stringField(value, "reason"),
    representation: stringField(value, "representation"),
  };
}

function routeFromUnknown(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

async function ensureDesktopControl(ctx: FlowContext, timeoutMs = 60_000): Promise<void> {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs, label: "desktop control API" });
}

async function ensureDesktopBridge(ctx: FlowContext): Promise<void> {
  await ensureDesktopControl(ctx, 120_000);
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", { timeoutMs: 60_000, label: "desktop bridge" });
}

async function currentRoute(ctx: FlowContext): Promise<string> {
  const route = await ctx.eval(`(() => {
    try {
      const snapshotRoute = window.__openworkControl?.snapshot?.().route;
      if (typeof snapshotRoute === 'string' && snapshotRoute) return snapshotRoute;
    } catch {}
    return window.location.hash.replace(/^#/, '') || window.location.pathname;
  })()`);
  return routeFromUnknown(route);
}

async function workspaceRouteReady(ctx: FlowContext): Promise<boolean> {
  return Boolean(await ctx.eval(`(() => {
    const hash = window.location.hash;
    const hasFolderInput = Boolean(document.querySelector('input[placeholder="/workspace/my-project"]'));
    return hash.includes('/workspace/') && !hasFolderInput;
  })()`));
}

async function chatFirstSessionReady(ctx: FlowContext): Promise<boolean> {
  // Provenance: apps/app/src/react-app/shell/session-route.tsx:2235-2257
  // supports chat-first onboarding on /session with a composer before a
  // workspace-scoped route exists; that is a usable first-run desktop surface.
  return Boolean(await ctx.eval(`(() => {
    const route = window.__openworkControl?.snapshot?.().route || window.location.hash.replace(/^#/, '') || window.location.pathname;
    const hasComposer = Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}));
    const hasFolderInput = Boolean(document.querySelector('input[placeholder="/workspace/my-project"]'));
    return route === '/session' && hasComposer && !hasFolderInput;
  })()`));
}

async function clickVisibleButton(ctx: FlowContext, labels: string[]): Promise<string> {
  const clicked = await ctx.eval(`(() => {
    const labels = ${JSON.stringify(labels)};
    const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const visibleEnabled = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        && element.disabled !== true && element.getAttribute('aria-disabled') !== 'true';
    };
    const button = [...document.querySelectorAll('button, [role="button"]')]
      .find((entry) => labels.some((label) => normalize(entry.textContent) === label || normalize(entry.textContent).startsWith(label)) && visibleEnabled(entry));
    button?.scrollIntoView({ block: 'center', inline: 'center' });
    button?.click();
    return button ? normalize(button.textContent) : '';
  })()`);
  return typeof clicked === "string" ? clicked : "";
}

async function setFolderInputIfVisible(ctx: FlowContext, workspacePath: string): Promise<boolean> {
  const hasInput = await ctx.eval("Boolean(document.querySelector('input[placeholder=\"/workspace/my-project\"]'))");
  if (!hasInput) return false;
  // Provenance: builtin-browser-tab-overflow.flow.mjs:18-31 and
  // durable-auth-mcp.flow.mjs:259-262 fill the manual folder input and click
  // "Use this folder" when onboarding exposes the non-native fallback field.
  await ctx.fill('input[placeholder="/workspace/my-project"]', workspacePath);
  await ctx.clickText("Use this folder", { selector: "button", timeoutMs: 15_000 });
  return true;
}

async function injectFolderIntoCreateWorkspaceModal(ctx: FlowContext, workspacePath: string): Promise<void> {
  // Provenance: evals/daytona-flows.md:116-132 and
  // builtin-browser-tab-overflow.flow.mjs:51-85 use the React fiber reducer for
  // CreateWorkspaceModal to bypass the native folder picker in coded flows.
  const result = await ctx.eval(`(() => {
    function findFiber(element) {
      const key = Object.keys(element).find((candidate) => candidate.startsWith('__reactFiber$'));
      return key ? element[key] : null;
    }
    const placeholder = [...document.querySelectorAll('span, div, p')]
      .find((node) => (node.textContent ?? '').includes('No folder'));
    if (!placeholder) return { ok: false, error: 'No folder placeholder not found' };
    let fiber = findFiber(placeholder);
    while (fiber) {
      const name = (fiber.elementType && fiber.elementType.name) || (fiber.type && fiber.type.name) || '';
      if (name === 'CreateWorkspaceModal') break;
      fiber = fiber.return;
    }
    if (!fiber) return { ok: false, error: 'CreateWorkspaceModal fiber not found' };
    let hook = fiber.memoizedState;
    while (hook) {
      if (hook.queue && hook.queue.dispatch) {
        hook.queue.dispatch({ key: 'selectedFolder', value: ${JSON.stringify(workspacePath)} });
        hook.queue.dispatch({ key: 'pickingFolder', value: false });
        return { ok: true };
      }
      hook = hook.next;
    }
    return { ok: false, error: 'folder dispatch not found' };
  })()`);
  if (!isRecord(result) || result.ok !== true) {
    const reason = isRecord(result) ? stringField(result, "error") : "unknown";
    throw new EvalError(`Could not inject workspace folder into CreateWorkspaceModal: ${reason}`);
  }
  await ctx.waitFor(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => (candidate.textContent ?? '').replace(/\s+/g, ' ').trim() === 'Create Workspace' && !candidate.disabled);
    if (!button) return false;
    button.click();
    return true;
  })()`, { timeoutMs: 15_000, label: "Create Workspace button" });
}

async function createWorkspaceFromWelcome(ctx: FlowContext, workspacePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let triedControl = false;
  let lastRoute = "";
  while (Date.now() < deadline) {
    if (await workspaceRouteReady(ctx) || await chatFirstSessionReady(ctx)) return;
    lastRoute = await currentRoute(ctx).catch(() => "");

    if (!triedControl) {
      triedControl = true;
      const canControlCreate = await ctx.eval("Boolean(window.__openworkControl?.listActions?.().find((action) => action.id === 'workspace.create' && !action.disabled))").catch(() => false);
      if (canControlCreate) {
        // Provenance: apps/app/src/react-app/shell/session-route.tsx:2260-2277
        // exposes workspace.create; durable-auth-mcp.flow.mjs:282-289 and
        // admin-desktop-skill-grants.flow.mjs:521-524 use it for pickerless
        // workspace creation when the action is mounted.
        await ctx.control("workspace.create", { path: workspacePath });
        await ctx.waitFor("window.location.hash.includes('/workspace/')", { timeoutMs: 60_000, label: "workspace route after control create" });
        return;
      }
    }

    if (await setFolderInputIfVisible(ctx, workspacePath)) {
      await ctx.waitFor("window.location.hash.includes('/workspace/')", { timeoutMs: 60_000, label: "workspace route after folder input" });
      return;
    }

    const clicked = await clickVisibleButton(ctx, [
      "Continue to workspace",
      "Continue without OpenWork Models",
      "Skip and use the free model",
      "Continue",
      "Skip",
      "Get started",
      "Local workspace",
    ]);
    if (clicked) {
      await sleep(500);
      continue;
    }

    const modalVisible = await ctx.eval("document.body.innerText.includes('No folder')").catch(() => false);
    if (modalVisible) {
      await injectFolderIntoCreateWorkspaceModal(ctx, workspacePath);
      await ctx.waitFor("window.location.hash.includes('/workspace/')", { timeoutMs: 60_000, label: "workspace route after modal create" });
      return;
    }

    await sleep(500);
  }
  throw new EvalError(`Desktop firstBoot did not reach a workspace route within ${timeoutMs}ms; last route: ${lastRoute}`);
}

async function getDesktopDenState(ctx: FlowContext): Promise<DesktopDenState> {
  const state = await ctx.eval(`(() => ({
    token: (localStorage.getItem('openwork.den.authToken') ?? '').trim(),
    baseUrl: (localStorage.getItem('openwork.den.baseUrl') ?? '').trim(),
    apiBaseUrl: (localStorage.getItem('openwork.den.apiBaseUrl') ?? '').trim(),
    activeOrgName: (localStorage.getItem('openwork.den.activeOrgName') ?? '').trim(),
  }))()`);
  return desktopDenStateFromUnknown(state);
}

async function desktopTokenMatchesActor(ctx: FlowContext, token: string, actor: Actor, denApiUrlValue: string, denWebUrlValue: string): Promise<boolean> {
  const me = await denApiFetch(ctx, "/v1/me", { headers: new Headers({ authorization: `Bearer ${token}` }) }, {
    denApiUrl: denApiUrlValue,
    denWebUrl: denWebUrlValue,
  }).catch(() => null);
  if (!me?.response.ok || !isRecord(me.body) || !isRecord(me.body.user)) return false;
  return stringField(me.body.user, "email").toLowerCase() === actor.email.trim().toLowerCase();
}

async function writeDesktopBootstrap(ctx: FlowContext, denWebUrlValue: string, denApiUrlValue: string): Promise<void> {
  // Provenance: marketplace-connect-only-delivery.flow.mjs:442-463 writes the
  // desktop bootstrap through the Electron bridge, mirrors openwork.den.*
  // localStorage keys, clears stale auth, then reloads before exchange.
  const bootstrap = { baseUrl: denWebUrlValue, apiBaseUrl: denApiUrlValue, requireSignin: false, handoff: null };
  const written = await ctx.eval(`(async () => {
    const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!bridge) return { ok: false, reason: 'desktop bridge missing' };
    await bridge('setDesktopBootstrapConfig', ${JSON.stringify(bootstrap)});
    localStorage.setItem('openwork.den.baseUrl', ${JSON.stringify(denWebUrlValue)});
    localStorage.setItem('openwork.den.apiBaseUrl', ${JSON.stringify(denApiUrlValue)});
    for (const key of [
      'openwork.den.authToken',
      'openwork.den.activeOrgId',
      'openwork.den.activeOrgSlug',
      'openwork.den.activeOrgName',
      'openwork.den.mcp.sync',
    ]) localStorage.removeItem(key);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('openwork.den.desktopConfig:')) localStorage.removeItem(key);
    }
    window.dispatchEvent(new CustomEvent('openwork-den-settings-changed', { detail: {} }));
    return { ok: true };
  })()`, { awaitPromise: true });
  if (!isRecord(written) || written.ok !== true) {
    const reason = isRecord(written) ? stringField(written, "reason") : "unknown";
    throw new EvalError(`Failed to write desktop Den bootstrap: ${reason}`);
  }
  await ctx.eval("location.reload(); true");
  await ensureDesktopControl(ctx, 60_000);
}

async function completeDesktopCloudOnboardingIfNeeded(ctx: FlowContext): Promise<void> {
  // Provenance: marketplace-connect-only-delivery.flow.mjs:495-520 and
  // first-connection.flow.mjs:851-884 click through org/resource/model gates
  // after Den auth until the workspace/session surface is reachable.
  const workspacePath = await mkdtemp(join(tmpdir(), "openwork-den-workspace-"));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await workspaceRouteReady(ctx)) return;
    const clicked = await clickVisibleButton(ctx, [
      "Continue with organization",
      "Continue to workspace",
      "Continue without OpenWork Models",
      "Skip and use the free model",
      "Continue",
      "Skip",
    ]).catch(() => "");
    if (clicked) {
      await sleep(800);
      continue;
    }
    if (await setFolderInputIfVisible(ctx, workspacePath).catch(() => false)) {
      await ctx.waitFor("window.location.hash.includes('/workspace/')", { timeoutMs: 60_000, label: "workspace route after Den onboarding folder" });
      return;
    }
    await sleep(800);
  }
}

async function setActiveOrganizationForToken(ctx: FlowContext, token: string, organizationId: string, denWebUrlValue: string, denApiUrlValue: string): Promise<void> {
  const result = await denApiFetch(ctx, "/v1/me/active-organization", {
    method: "POST",
    headers: new Headers({ authorization: `Bearer ${token}` }),
    body: JSON.stringify({ organizationId }),
  }, { denWebUrl: denWebUrlValue, denApiUrl: denApiUrlValue });
  if (!result.response.ok) {
    throw new EvalError(`Could not set active organization ${organizationId} before desktop handoff: ${result.response.status} ${result.text.slice(0, 300)}`);
  }
}

async function createDesktopHandoff(ctx: FlowContext, actor: Actor, denWebUrlValue: string, denApiUrlValue: string, organizationId?: string): Promise<string> {
  const token = await apiSignIn(ctx, { actor, denWebUrl: denWebUrlValue, denApiUrl: denApiUrlValue });
  if (organizationId) await setActiveOrganizationForToken(ctx, token, organizationId, denWebUrlValue, denApiUrlValue);
  // Provenance: marketplace-connect-only-delivery.flow.mjs:465-475,
  // org-connections-capability.flow.mjs:764-777, and durable-auth-mcp.flow.mjs
  // :314-320 use /v1/auth/desktop-handoff followed by the auth.exchange-grant
  // control action against the local Den stack.
  const handoff = await denApiFetch(ctx, "/v1/auth/desktop-handoff", {
    method: "POST",
    headers: new Headers({ authorization: `Bearer ${token}` }),
    body: JSON.stringify({ desktopScheme: "openwork" }),
  }, { denWebUrl: denWebUrlValue, denApiUrl: denApiUrlValue });
  if (!handoff.response.ok || !isRecord(handoff.body) || typeof handoff.body.grant !== "string") {
    throw new EvalError(`Desktop handoff create failed: ${handoff.response.status} ${handoff.text.slice(0, 300)}`);
  }
  return handoff.body.grant;
}

async function currentSessionRoute(ctx: FlowContext): Promise<string | undefined> {
  const route = await currentRoute(ctx).catch(() => "");
  return route.includes("/session") ? route : undefined;
}

async function pastePrompt(ctx: FlowContext, prompt: string): Promise<PasteResult> {
  // Provenance: enterprise-gateway-common.mjs:539-609 is the robust Lexical
  // synthetic ClipboardEvent('paste') path used for prompts and pasted chips;
  // core-flow.flow.mjs:33-44 is the minimal same-event smoke proof.
  const raw = await ctx.eval(`(async () => {
    const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    if (!editor) return { ok: false, reason: 'composer not found' };
    const prompt = ${JSON.stringify(prompt)};
    const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const readText = () => editor.innerText || editor.textContent || '';
    const selectEditorContents = () => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    editor.focus();
    if (normalize(readText())) {
      selectEditorContents();
      editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'a', code: 'KeyA', metaKey: navigator.platform.includes('Mac'), ctrlKey: !navigator.platform.includes('Mac') }));
      editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward', data: null }));
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      await waitFrame();
    }
    selectEditorContents();
    const data = new DataTransfer();
    data.setData('text/plain', prompt);
    editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    await waitFrame();
    await waitFrame();
    const text = readText();
    const inlineMatched = normalize(text).includes(normalize(prompt));
    const pastedChip = [...document.querySelectorAll('button[data-pasted-expand-label]')]
      .some((button) => (button.closest('span')?.textContent ?? button.textContent ?? '').includes(prompt.slice(0, 40)));
    return { ok: inlineMatched || pastedChip, representation: inlineMatched ? 'inline' : pastedChip ? 'pasted-chip' : 'missing', text: text.slice(0, 500) };
  })()`, { awaitPromise: true });
  return pasteResultFromUnknown(raw);
}

async function clickRunOrPressEnter(ctx: FlowContext): Promise<string> {
  // Provenance: enterprise-gateway-common.mjs:612-617 clicks "Run task";
  // core-flow.flow.mjs:129-141 falls back to Enter when no button label matches.
  const submitted = await ctx.eval(`(() => {
    const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const button = [...document.querySelectorAll('button')]
      .find((entry) => (/run task|send|run/i).test(normalize(entry.textContent) || entry.title || '') && entry.disabled !== true);
    if (button) {
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return 'clicked';
    }
    const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    if (editor) {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      return 'enter';
    }
    return '';
  })()`);
  return typeof submitted === "string" ? submitted : "";
}

async function waitForAssistantActivity(ctx: FlowContext, timeoutMs: number): Promise<void> {
  await ctx.waitFor(`(() => {
    const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const assistant = [...document.querySelectorAll('[data-message-role="assistant"], .markdown-content')]
      .some((element) => normalize(element.textContent).length > 0 && normalize(element.textContent) !== 'OpenWork');
    const active = [...document.querySelectorAll('[aria-label]')]
      .some((element) => ['Thinking', 'Responding', 'Waiting', 'Session streaming', 'Session active'].includes(element.getAttribute('aria-label') ?? ''));
    return assistant || active;
  })()`, { timeoutMs, label: "assistant response or activity" });
}

export async function firstBoot(ctx: FlowContext, options: FirstBootOptions): Promise<FirstBootResult> {
  const workspacePath = options.workspacePath?.trim() || await mkdtemp(join(tmpdir(), "openwork-workspace-"));
  await mkdir(workspacePath, { recursive: true });
  await ctx.on(options.surface, async () => {
    await ensureDesktopControl(ctx, options.timeoutMs ?? DEFAULT_FIRST_BOOT_TIMEOUT_MS);
    if (await workspaceRouteReady(ctx) || await chatFirstSessionReady(ctx)) {
      ctx.log(`Desktop already has a usable first-run route: ${await currentRoute(ctx)}`);
      return;
    }
    const route = await currentRoute(ctx).catch(() => "");
    if (route.startsWith("/settings")) {
      await ctx.navigateHash("/session");
      await ctx.waitFor(`(() => {
        const route = window.__openworkControl?.snapshot?.().route || window.location.hash.replace(/^#/, '') || window.location.pathname;
        return route === '/session' && Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}));
      })()`, { timeoutMs: 30_000, label: "chat-first session from settings" });
      ctx.log("Desktop returned from settings to the chat-first session route.");
      return;
    }
    await createWorkspaceFromWelcome(ctx, workspacePath, options.timeoutMs ?? DEFAULT_FIRST_BOOT_TIMEOUT_MS);
    await ctx.waitFor(`(() => {
      const route = window.__openworkControl?.snapshot?.().route || window.location.hash.replace(/^#/, '') || window.location.pathname;
      const hasComposer = Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}));
      return window.location.hash.includes('/workspace/') || (route === '/session' && hasComposer);
    })()`, {
      timeoutMs: options.timeoutMs ?? DEFAULT_FIRST_BOOT_TIMEOUT_MS,
      label: "workspace or chat-first route loaded",
    });
  });
  return { workspacePath };
}

export async function connectDen(ctx: FlowContext, options: ConnectDenOptions): Promise<ConnectDenResult> {
  const actor = validateActor(options.actor);
  const baseUrl = resolveDenWebUrl(ctx.env, options.denWebUrl);
  const apiBaseUrl = resolveDenApiUrl(ctx.env, options.denApiUrl);
  return ctx.on(options.surface, async () => {
    await ensureDesktopBridge(ctx);
    const current = await getDesktopDenState(ctx);
    const baseMatches = normalizeBaseUrl(current.baseUrl) === normalizeBaseUrl(baseUrl)
      && normalizeBaseUrl(current.apiBaseUrl) === normalizeBaseUrl(apiBaseUrl);
    const orgMatches = !options.organizationName || current.activeOrgName === options.organizationName;
    if (current.token && baseMatches && orgMatches && await desktopTokenMatchesActor(ctx, current.token, actor, apiBaseUrl, baseUrl)) {
      await completeDesktopCloudOnboardingIfNeeded(ctx);
      ctx.log(`Desktop is already connected to ${baseUrl} as ${actor.email}.`);
      return { email: actor.email, baseUrl, apiBaseUrl, activeOrgName: current.activeOrgName || undefined, status: "already-connected" };
    }
    if (current.token && baseMatches && !orgMatches) {
      ctx.log(`Desktop is connected to ${current.activeOrgName || "unknown org"}; reconnecting to scope ${options.organizationName ?? "requested org"}.`);
    }

    await writeDesktopBootstrap(ctx, baseUrl, apiBaseUrl);
    const grant = await createDesktopHandoff(ctx, actor, baseUrl, apiBaseUrl, options.organizationId);
    await ctx.waitFor("Boolean(window.__openworkControl?.listActions?.().some((action) => action.id === 'auth.exchange-grant' && !action.disabled))", {
      timeoutMs: 30_000,
      label: "auth.exchange-grant control action",
    });
    await ctx.control("auth.exchange-grant", { grant, baseUrl });
    await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", {
      timeoutMs: 60_000,
      label: "persisted Den auth token",
    });
    await completeDesktopCloudOnboardingIfNeeded(ctx);
    const after = await getDesktopDenState(ctx);
    if (options.organizationName && after.activeOrgName && after.activeOrgName !== options.organizationName) {
      throw new EvalError(`Desktop connected to ${after.activeOrgName}, expected ${options.organizationName}.`);
    }
    ctx.log(`Desktop connected to ${baseUrl} as ${actor.email}; active org: ${after.activeOrgName || "unknown"}.`);
    return { email: actor.email, baseUrl, apiBaseUrl, activeOrgName: after.activeOrgName || undefined, status: "connected" };
  });
}

export async function runPrompt(ctx: FlowContext, options: RunPromptOptions): Promise<RunPromptResult> {
  const submit = options.submit ?? true;
  const expectResponse = options.expectResponse ?? submit;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  if (!options.prompt.trim()) throw new EvalError("runPrompt requires a non-empty prompt.");
  return ctx.on(options.surface, async () => {
    await ensureDesktopControl(ctx, 90_000);
    await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}))`, { timeoutMs: 90_000, label: "Lexical composer" });
    const pasted = await pastePrompt(ctx, options.prompt);
    if (!pasted.ok) throw new EvalError(`Failed to paste prompt into composer: ${pasted.reason || pasted.representation || "unknown"}`);
    if (!submit) return { sessionRoute: await currentSessionRoute(ctx) };
    const submitted = await clickRunOrPressEnter(ctx);
    if (!submitted) throw new EvalError("Could not submit the composer prompt with Run task or Enter.");
    ctx.log(`Submitted prompt via ${submitted}.`);
    await ctx.waitFor("window.location.hash.includes('/session') || window.__openworkControl?.snapshot?.().route?.includes('/session')", {
      timeoutMs: 60_000,
      label: "session route after prompt submit",
    });
    if (expectResponse) await waitForAssistantActivity(ctx, timeoutMs);
    return { sessionRoute: await currentSessionRoute(ctx) };
  });
}

export async function openSettings(ctx: FlowContext, options: OpenSettingsOptions): Promise<OpenSettingsResult> {
  return ctx.on(options.surface, async () => {
    await ensureDesktopControl(ctx, 60_000);
    const section = options.section?.trim() || "cloud-account";
    const workspaceId = await ctx.eval(`(() => {
      const match = window.location.hash.match(/\/workspace\/([^/]+)/);
      return match?.[1] || localStorage.getItem('openwork.react.activeWorkspace') || '';
    })()`);
    const route = typeof workspaceId === "string" && workspaceId
      ? `/workspace/${workspaceId}/settings/${section}`
      : `/settings/${section}`;
    // Provenance: first-connection.flow.mjs:880-884 uses /settings/cloud-account;
    // marketplace-connect-only-delivery.flow.mjs:547-548 uses the workspace-
    // scoped /workspace/<id>/settings/<tab> hash route when a workspace exists.
    await ctx.navigateHash(route);
    await ctx.waitFor(`window.location.hash.includes(${JSON.stringify(`/settings/${section}`)})`, {
      timeoutMs: 30_000,
      label: `settings ${section}`,
    });
    return { route };
  });
}
