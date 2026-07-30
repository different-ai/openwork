import { execSync } from "node:child_process";
import { EvalError } from "../context.ts";
import type { Actor } from "../actors.ts";
import type { FlowContext } from "../flow.ts";
import type { Surface } from "../surfaces.ts";

export interface DenUrlOptions {
  denApiUrl?: string;
  denWebUrl?: string;
}

export interface DenUrls {
  apiUrl: string;
  webUrl: string;
}

export interface SignInWebOptions {
  surface: string | Surface;
  actor: Actor;
}

export interface ApiSignInOptions extends DenUrlOptions {
  actor: Actor;
}

export interface CreateOrgOptions {
  surface: string | Surface;
  actor: Actor;
  name: string;
  slug?: string;
}

export interface CreateOrgResult {
  orgId?: string;
  slug: string;
  name: string;
  path: "api+ui-verify";
}

export interface InviteMemberOptions {
  surface?: string | Surface;
  actor: Actor;
  email: string;
  role?: string;
  organizationId?: string;
}

export interface InviteRef {
  inviteUrl?: string;
  token?: string;
  email?: string;
  invitationId?: string;
}

export interface InviteMemberResult extends InviteRef {
  email: string;
  path: "ui" | "api";
}

export interface AcceptInviteOptions {
  surface: string | Surface;
  actor: Actor;
  invite: InviteRef;
  allowApiFallback?: boolean;
}

export interface AcceptInviteResult {
  email: string;
  inviteUrl: string;
  status: "accepted";
}

export interface DenApiFetchResult {
  response: Response;
  body: unknown;
  text: string;
}

interface BrowserOrganization {
  id: string;
  name: string;
  slug: string;
}

const AUTH_TOKEN_STORAGE_KEY = "openwork:web:auth-token";
const DEFAULT_INVITE_ROLE = "member";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActorRole(value: unknown): value is Actor["role"] {
  return value === "owner" || value === "member" || value === "fresh";
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRuntimeEvaluateTimeout(error: unknown): boolean {
  return messageText(error).includes("CDP call Runtime.evaluate timed out");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonText(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function cleanBaseUrlRequired(value: string | undefined, envName: string): string {
  const cleaned = cleanBaseUrl(value);
  if (!cleaned) throw new EvalError(`${envName} is required for Den journeys.`);
  return cleaned;
}

function authHeaders(token: string): Headers {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

function orgScopedAuthHeaders(token: string, organizationId?: string): Headers {
  const headers = authHeaders(token);
  if (organizationId) headers.set("x-openwork-org-id", organizationId);
  return headers;
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

function slugFromName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "organization";
}

function organizationFromPayload(body: unknown, fallbackName: string, fallbackSlug?: string): BrowserOrganization {
  const organization = isRecord(body) && isRecord(body.organization) ? body.organization : null;
  if (!organization) {
    throw new EvalError(`Organization response did not include an organization object: ${JSON.stringify(body).slice(0, 500)}`);
  }
  const id = stringField(organization, "id");
  const name = stringField(organization, "name") || fallbackName;
  const slug = stringField(organization, "slug") || fallbackSlug?.trim() || slugFromName(name);
  return { id, name, slug };
}

function findInviteString(value: unknown, keys: Set<string>, depth: number): string {
  if (depth > 8) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.includes("/join-org?invite=") ? trimmed : "";
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findInviteString(entry, keys, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (!isRecord(value)) return "";
  for (const [key, entry] of Object.entries(value)) {
    if (keys.has(key) && typeof entry === "string" && entry.trim()) return entry.trim();
  }
  for (const entry of Object.values(value)) {
    const found = findInviteString(entry, keys, depth + 1);
    if (found) return found;
  }
  return "";
}

function findTokenString(value: unknown, keys: Set<string>, depth: number): string {
  if (depth > 8) return "";
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findTokenString(entry, keys, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (!isRecord(value)) return "";
  for (const [key, entry] of Object.entries(value)) {
    if (keys.has(key) && typeof entry === "string" && entry.trim()) return entry.trim();
  }
  for (const entry of Object.values(value)) {
    const found = findTokenString(entry, keys, depth + 1);
    if (found) return found;
  }
  return "";
}

function invitationIdFromBody(body: unknown): string {
  if (!isRecord(body)) return "";
  return stringField(body, "invitationId") || stringField(body, "id");
}

function pendingInviteFromOrgBody(body: unknown, email: string): InviteRef {
  if (!isRecord(body) || !Array.isArray(body.invitations)) return {};
  const targetEmail = normalizedEmail(email);
  for (const entry of body.invitations) {
    if (!isRecord(entry)) continue;
    const candidateEmail = normalizedEmail(stringField(entry, "email"));
    const status = stringField(entry, "status");
    const token = stringField(entry, "inviteToken");
    if (candidateEmail === targetEmail && status === "pending" && token) {
      return {
        token,
        invitationId: stringField(entry, "id") || stringField(entry, "invitationId"),
      };
    }
  }
  return {};
}

function firstDevEmailRecipient(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.emails)) return "";
  const first = body.emails[0];
  return isRecord(first) ? stringField(first, "to") : "";
}

function resultStatus(result: unknown): string {
  if (!isRecord(result)) return "unknown";
  const status = result.status;
  return typeof status === "number" || typeof status === "string" ? String(status) : "unknown";
}

function verificationCodeFromHtml(html: string): string {
  const matches = html.match(/\b\d{6}\b/g);
  return matches?.[0] ?? "";
}

function webFetchBase(path: string, urls: DenUrls): string {
  // Provenance: evals/flows/lib/den-web.mjs:13-24 routes Better Auth
  // requests through den-web so the proxy can supply a trusted Origin.
  return path.startsWith("/api/auth/") && urls.webUrl ? urls.webUrl : urls.apiUrl;
}

export function cleanBaseUrl(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

export function resolveDenApiUrl(env: NodeJS.ProcessEnv, override?: string): string {
  return cleanBaseUrlRequired(override ?? env.OPENWORK_EVAL_DEN_API_URL, "OPENWORK_EVAL_DEN_API_URL");
}

export function resolveDenWebUrl(env: NodeJS.ProcessEnv, override?: string): string {
  return cleanBaseUrlRequired(override ?? env.OPENWORK_EVAL_DEN_WEB_URL, "OPENWORK_EVAL_DEN_WEB_URL");
}

export function resolveDenUrls(env: NodeJS.ProcessEnv, options: DenUrlOptions = {}): DenUrls {
  return {
    apiUrl: resolveDenApiUrl(env, options.denApiUrl),
    webUrl: resolveDenWebUrl(env, options.denWebUrl),
  };
}

export function denApiUrl(ctx: FlowContext): string {
  return resolveDenApiUrl(ctx.env);
}

export function denWebUrl(ctx: FlowContext): string {
  return resolveDenWebUrl(ctx.env);
}

export function validateActor(actor: unknown, label = "actor"): Actor {
  if (isRecord(actor) && typeof actor.name === "string" && typeof actor.email === "string" && typeof actor.password === "string" && isActorRole(actor.role)) {
    return { name: actor.name, email: actor.email, password: actor.password, role: actor.role };
  }
  throw new EvalError(`${label} must include name, email, password, and role.`);
}

export function inviteUrlFromToken(webUrl: string, token: string): string {
  const trimmed = token.trim();
  if (!trimmed) throw new EvalError("Invite token is empty; cannot build join URL.");
  const url = new URL("/join-org", `${cleanBaseUrl(webUrl)}/`);
  url.searchParams.set("invite", trimmed);
  return url.toString();
}

export function decodeHtmlAttribute(value: string): string {
  // Decode `&amp;` last so composite sequences like `&amp;quot;` decode once
  // (to `&quot;`), never twice (lgtm: double-unescaping).
  return value
    .replaceAll("&#x2F;", "/")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

export function normalizeInviteUrl(rawInviteUrl: string, webUrl: string): InviteRef {
  const decoded = decodeHtmlAttribute(rawInviteUrl.trim());
  if (!decoded) throw new EvalError("Invite URL is empty.");
  const parsed = new URL(decoded, `${cleanBaseUrl(webUrl)}/`);
  const token = parsed.searchParams.get("invite")?.trim() ?? "";
  if (!token) throw new EvalError(`Invite URL did not include an invite token: ${decoded}`);
  // Provenance: invite-to-desktop.flow.mjs:741-745 rewrites email-rendered
  // links onto OPENWORK_EVAL_DEN_WEB_URL because the email origin can differ
  // from the browser-driven den-web origin in the local stack.
  const rewritten = new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, `${cleanBaseUrl(webUrl)}/`).toString();
  return { inviteUrl: rewritten, token };
}

export function extractInviteFromHtml(html: string, webUrl: string): InviteRef {
  // Provenance: invite-to-desktop.flow.mjs:687-697 extracts the real
  // /join-org?invite= link from the dev email HTML and validates the token.
  const absolute = html.match(/https?:\/\/[^"'<>\s]+\/join-org\?invite=[^"'<>\s]+/);
  const relative = html.match(/\/join-org\?invite=[^"'<>\s]+/);
  const raw = absolute?.[0] ?? relative?.[0] ?? "";
  if (!raw) throw new EvalError("Invite HTML did not contain a /join-org?invite= link.");
  return normalizeInviteUrl(raw, webUrl);
}

export function extractInviteFromPayload(payload: unknown, webUrl: string): InviteRef {
  const linkKeys = new Set(["inviteUrl", "inviteURL", "inviteLink", "link", "url", "acceptLink"]);
  const tokenKeys = new Set(["inviteToken", "token"]);
  const rawLink = findInviteString(payload, linkKeys, 0);
  if (rawLink) return normalizeInviteUrl(rawLink, webUrl);
  const token = findTokenString(payload, tokenKeys, 0);
  if (token) return { inviteUrl: inviteUrlFromToken(webUrl, token), token };
  throw new EvalError(`Invite payload did not include an invite URL or token: ${JSON.stringify(payload).slice(0, 500)}`);
}

export async function denApiFetch(ctx: FlowContext, path: string, init: RequestInit = {}, options: DenUrlOptions = {}): Promise<DenApiFetchResult> {
  const urls = resolveDenUrls(ctx.env, options);
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body !== undefined) headers.set("content-type", "application/json");
  if (!headers.has("origin")) headers.set("origin", urls.webUrl);
  const response = await fetch(`${webFetchBase(path, urls)}${path}`, { ...init, headers });
  const text = await response.text();
  return { response, text, body: parseJsonText(text) };
}

export async function apiSignIn(ctx: FlowContext, options: ApiSignInOptions): Promise<string> {
  const actor = validateActor(options.actor);
  const body = JSON.stringify({ email: actor.email, password: actor.password });
  // Provenance: evals/flows/lib/den-web.mjs:35-42 and
  // invite-to-desktop.flow.mjs:492-507 authenticate through
  // /api/auth/sign-in/email and read the returned Better Auth bearer token.
  let result = await denApiFetch(ctx, "/api/auth/sign-in/email", {
    method: "POST",
    body,
  }, options);
  if (!result.response.ok && ((result.response.status === 401 && result.text.includes("Invalid or expired token")) || (result.response.status === 403 && result.text.includes("Invalid origin")))) {
    const urls = resolveDenUrls(ctx.env, options);
    const authOrigin = ctx.env.OPENWORK_EVAL_DEN_AUTH_ORIGIN?.trim() || urls.webUrl;
    const headers = new Headers();
    headers.set("content-type", "application/json");
    headers.set("origin", authOrigin);
    const response = await fetch(`${urls.apiUrl}/api/auth/sign-in/email`, { method: "POST", headers, body });
    const text = await response.text();
    result = { response, text, body: parseJsonText(text) };
  }
  if (!result.response.ok || !isRecord(result.body) || typeof result.body.token !== "string" || !result.body.token.trim()) {
    throw new EvalError(`Den API sign-in failed for ${actor.email}: ${result.response.status} ${result.text.slice(0, 300)}`);
  }
  ctx.log(`Den API sign-in succeeded for ${actor.email}.`);
  return result.body.token;
}

async function waitForReadyStateComplete(ctx: FlowContext, label: string): Promise<void> {
  try {
    await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 45_000, label });
  } catch (error) {
    if (!isRuntimeEvaluateTimeout(error)) throw error;
    ctx.log(`${label} hit a stalled CDP evaluate; reconnecting once.`);
    await ctx.reconnect();
    await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 45_000, label });
  }
}

async function navigateAbsolute(ctx: FlowContext, url: string, label = url): Promise<void> {
  // Normalize through the URL parser so only a well-formed absolute URL is
  // ever navigated to (and interpolated into the eval fallback below).
  const safeUrl = new URL(url).toString();
  const navigated = ctx.client
    ? await ctx.client.send("Page.navigate", { url: safeUrl }).then(() => true).catch((error) => {
      ctx.log(`CDP Page.navigate failed for ${label}; falling back to window.location: ${messageText(error)}`);
      return false;
    })
    : false;
  if (!navigated) await ctx.eval(`(() => { window.location.href = ${JSON.stringify(safeUrl)}; return true; })()`);
  await waitForReadyStateComplete(ctx, `load ${label}`);
  await dismissDaytonaPreviewWarning(ctx, label);
}

async function dismissDaytonaPreviewWarning(ctx: FlowContext, label: string): Promise<void> {
  const clicked = await ctx.eval(`(() => {
    const bodyText = document.body?.innerText ?? '';
    if (!bodyText.includes('Preview URL Warning')) return false;
    const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const control = [...document.querySelectorAll('button, a')]
      .find((entry) => normalize(entry.textContent).includes('I Understand'));
    control?.scrollIntoView({ block: 'center', inline: 'center' });
    control?.click();
    return Boolean(control);
  })()`).catch(() => false);
  if (!clicked) return;
  ctx.log(`Dismissed Daytona preview warning for ${label}.`);
  await sleep(800);
  await waitForReadyStateComplete(ctx, `load ${label} after preview warning`);
  await ctx.waitFor("!(document.body?.innerText ?? '').includes('Preview URL Warning')", { timeoutMs: 45_000, label: `leave Daytona preview warning for ${label}` });
}

async function clearDenWebSession(ctx: FlowContext, webUrl: string): Promise<void> {
  // Provenance: first-connection.flow.mjs:671-685 clears both den-web and
  // proxied den-api auth state before browser sign-in / invite acceptance.
  await navigateAbsolute(ctx, webUrl, "den-web root before sign-out");
  await ctx.eval(`(() => {
    window.localStorage.removeItem(${JSON.stringify(AUTH_TOKEN_STORAGE_KEY)});
    window.sessionStorage.clear();
    return Promise.allSettled([
      fetch('/api/den/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    ]).then(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
      return true;
    });
  })()`, { awaitPromise: true });
  if (ctx.client) {
    await ctx.client.send("Network.clearBrowserCookies", {}).catch((error) => ctx.log(`Cookie clear skipped: ${messageText(error)}`));
    await ctx.client.send("Network.clearBrowserCache", {}).catch((error) => ctx.log(`Cache clear skipped: ${messageText(error)}`));
  }
}

async function clickExactText(ctx: FlowContext, text: string, selector = "button, a", timeoutMs = 20_000): Promise<void> {
  const expression = `(() => {
    const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((candidate) => normalize(candidate.textContent) === ${JSON.stringify(text)} && candidate.disabled !== true && candidate.getAttribute('aria-disabled') !== 'true');
    element?.scrollIntoView({ block: 'center', inline: 'center' });
    element?.click();
    return Boolean(element);
  })()`;
  try {
    await ctx.waitFor(expression, { timeoutMs, label: `click ${text}` });
  } catch (error) {
    if (!isRuntimeEvaluateTimeout(error)) throw error;
    ctx.log(`click ${text} hit a stalled CDP evaluate; reconnecting once.`);
    await ctx.reconnect();
    await ctx.waitFor(expression, { timeoutMs, label: `click ${text}` });
  }
}

async function clickLastExactText(ctx: FlowContext, text: string, selector = "button", timeoutMs = 20_000): Promise<void> {
  const expression = `(() => {
    const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((candidate) => normalize(candidate.textContent) === ${JSON.stringify(text)} && candidate.disabled !== true && candidate.getAttribute('aria-disabled') !== 'true');
    const element = candidates[candidates.length - 1];
    element?.scrollIntoView({ block: 'center', inline: 'center' });
    element?.click();
    return Boolean(element);
  })()`;
  try {
    await ctx.waitFor(expression, { timeoutMs, label: `click last ${text}` });
  } catch (error) {
    if (!isRuntimeEvaluateTimeout(error)) throw error;
    ctx.log(`click last ${text} hit a stalled CDP evaluate; reconnecting once.`);
    await ctx.reconnect();
    await ctx.waitFor(expression, { timeoutMs, label: `click last ${text}` });
  }
}

async function waitForAuthForm(ctx: FlowContext): Promise<void> {
  await ctx.waitFor(
    `document.body.innerText.includes('Sign in')
      || document.body.innerText.includes('Start using OpenWork')
      || Boolean(document.querySelector('input[type="email"], input[name="email"]'))`,
    { timeoutMs: 45_000, label: "den-web auth form" },
  );
}

async function settleDashboard(ctx: FlowContext, autoChoose: boolean): Promise<void> {
  const dashboardLoadedExpression = `(() => {
    const text = document.body?.innerText ?? '';
    const chooser = document.querySelector('[data-testid="org-chooser-root"]');
    return location.pathname.startsWith('/dashboard') && !chooser && text.includes('Dashboard');
  })()`;
  const entryExpression = autoChoose
    ? `${dashboardLoadedExpression} || Boolean(document.querySelector('[data-testid="org-chooser-list"]'))`
    : `(() => {
      const text = document.body?.innerText ?? '';
      return text.includes('Dashboard') || Boolean(document.querySelector('[data-testid="org-chooser-root"]')) || location.pathname.startsWith('/dashboard');
    })()`;
  await ctx.waitFor(
    entryExpression,
    { timeoutMs: 60_000, label: "dashboard or organization chooser" },
  );
  if (!autoChoose) return;
  const hasChooser = await ctx.eval("Boolean(document.querySelector('[data-testid=\"org-chooser-list\"]'))");
  if (!hasChooser) return;
  const chooseExpression = `(() => {
    const chooser = document.querySelector('[data-testid="org-chooser-list"]');
    if (!chooser) return false;
    const button = chooser.querySelector('button:not([disabled])');
    button?.click();
    return Boolean(button);
  })()`;
  let chose: unknown;
  try {
    chose = await ctx.waitFor(chooseExpression, { timeoutMs: 20_000, label: "choose first organization" });
  } catch (error) {
    if (!isRuntimeEvaluateTimeout(error)) throw error;
    ctx.log("organization chooser click hit a stalled CDP evaluate; reconnecting once.");
    await ctx.reconnect();
    chose = await ctx.waitFor(chooseExpression, { timeoutMs: 20_000, label: "choose first organization" });
  }
  if (chose) ctx.log("Selected the first organization from the Den Web chooser.");
  try {
    await ctx.waitFor(dashboardLoadedExpression, {
      timeoutMs: 60_000,
      label: "Den dashboard loaded",
    });
  } catch (error) {
    if (!isRuntimeEvaluateTimeout(error)) throw error;
    ctx.log("Den dashboard loaded hit a stalled CDP evaluate; reconnecting once.");
    await ctx.reconnect();
    await ctx.waitFor(dashboardLoadedExpression, {
      timeoutMs: 60_000,
      label: "Den dashboard loaded",
    });
  }
}

async function signInWebOnCurrentSurface(ctx: FlowContext, actor: Actor, autoChoose: boolean): Promise<void> {
  const webUrl = denWebUrl(ctx);
  // Provenance: evals/flows/lib/den-web.mjs:44-105 and
  // first-connection.flow.mjs:623-669 cover the email-first and password
  // forms, including hosted sessions that first render a sign-in affordance.
  await clearDenWebSession(ctx, webUrl);
  await navigateAbsolute(ctx, webUrl, "den-web auth");
  try {
    await waitForAuthForm(ctx);
  } catch (error) {
    ctx.log(`Den Web auth form did not appear for ${actor.email}; using API token handoff: ${messageText(error)}`);
    const token = await apiSignIn(ctx, { actor });
    await ctx.eval(`(() => {
      window.localStorage.setItem(${JSON.stringify(AUTH_TOKEN_STORAGE_KEY)}, ${JSON.stringify(token)});
      window.location.href = ${JSON.stringify(`${webUrl}/dashboard`)};
      return true;
    })()`);
    await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 45_000, label: "Den dashboard after API token handoff" });
    await settleDashboard(ctx, autoChoose);
    ctx.log(`Den Web API token handoff completed for ${actor.email}.`);
    return;
  }
  const hasInitialInput = await ctx.eval("Boolean(document.querySelector('input[type=\"email\"], input[name=\"email\"]')) || Boolean(document.querySelector('input[type=\"password\"]'))");
  if (!hasInitialInput) {
    await clickExactText(ctx, "Sign in", "button, a", 20_000).catch(() => undefined);
  }
  await ctx.waitFor(
    `Boolean(document.querySelector('input[type="email"], input[name="email"]')) || Boolean(document.querySelector('input[type="password"]'))`,
    { timeoutMs: 30_000, label: "auth inputs" },
  );
  const hasEmailInput = await ctx.eval("Boolean(document.querySelector('input[type=\"email\"], input[name=\"email\"]'))");
  const hasPasswordInput = await ctx.eval("Boolean(document.querySelector('input[type=\"password\"]'))");
  if (hasEmailInput) await ctx.fill('input[type="email"], input[name="email"]', actor.email);
  if (hasEmailInput && !hasPasswordInput) {
    const advanced = await ctx.eval(`(() => {
      const form = document.querySelector('input[type="email"], input[name="email"]')?.closest('form');
      const button = [...(form?.querySelectorAll('button') ?? [])].find((entry) => ['Next', 'Continue'].includes((entry.textContent ?? '').trim()))
        ?? form?.querySelector('button[type="submit"]');
      button?.click();
      return Boolean(button);
    })()`);
    ctx.assert(advanced, "No Next button found on the Den Web email step.");
    await ctx.waitFor("Boolean(document.querySelector('input[type=\"password\"]'))", { timeoutMs: 30_000, label: "password step" });
  }
  await ctx.fill('input[type="password"]', actor.password);
  await clickLastExactText(ctx, "Sign in", "button", 20_000);
  await settleDashboard(ctx, autoChoose);
  ctx.log(`Den Web sign-in completed for ${actor.email}.`);
}

async function chooseOrgByName(ctx: FlowContext, name: string): Promise<void> {
  await ctx.waitFor(
    `Boolean(document.querySelector('[data-testid="org-chooser-list"]')) || location.pathname.startsWith('/dashboard')`,
    { timeoutMs: 60_000, label: "organization chooser or dashboard" },
  );
  const normalizedName = name.replace(/\s+/g, " ").trim().toLowerCase();
  const uniqueSuffix = name.trim().split(/\s+/).at(-1)?.toLowerCase() ?? "";
  let lastResult = "not attempted";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const pickerResult = await ctx.eval(`(() => {
      const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
      const target = ${JSON.stringify(normalizedName)};
      const targetSuffix = ${JSON.stringify(uniqueSuffix)};
      const matchesTarget = (value) => {
        const candidate = normalize(value).toLowerCase();
        return candidate.includes(target) || (targetSuffix.length >= 4 && candidate.includes(targetSuffix));
      };
      const bodyText = normalize(document.body.innerText).toLowerCase();
      const chooser = document.querySelector('[data-testid="org-chooser-list"]');
      if (chooser) {
        const buttons = [...chooser.querySelectorAll('button')];
        const button = buttons.find((entry) => matchesTarget(entry.textContent) && entry.disabled !== true);
        if (button) {
          button.scrollIntoView({ block: 'center', inline: 'center' });
          button.click();
          return 'picked';
        }
        const root = document.querySelector('[data-testid="org-chooser-root"]');
        const search = root?.querySelector('input[type="search"]');
        if (search instanceof HTMLInputElement && search.value !== ${JSON.stringify(name)}) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(search, ${JSON.stringify(name)});
          search.dispatchEvent(new Event('input', { bubbles: true }));
          search.dispatchEvent(new Event('change', { bubbles: true }));
          return 'filtered';
        }
        const more = [...document.querySelectorAll('button')].find((entry) => normalize(entry.textContent).startsWith('Show more') && entry.disabled !== true);
        if (more) {
          more.click();
          return 'more';
        }
        return 'missing-in-chooser:' + buttons.slice(0, 8).map((entry) => normalize(entry.textContent)).join(' | ');
      }
      if (matchesTarget(bodyText)) return 'current';
      return 'missing-on-dashboard';
    })()`);
    lastResult = typeof pickerResult === "string" ? pickerResult : String(pickerResult);
    if (lastResult === "picked") {
      await ctx.waitFor(
        `document.body.innerText.includes(${JSON.stringify(name)}) && (location.pathname.startsWith('/dashboard') || document.body.innerText.includes('Dashboard'))`,
        { timeoutMs: 60_000, label: `dashboard after choosing ${name}` },
      );
      ctx.log(`Verified ${name} in the Den Web organization chooser and selected it.`);
      return;
    }
    if (lastResult === "current") {
      ctx.log(`Verified ${name} in the current Den Web dashboard text.`);
      return;
    }
    if (attempt === 5) {
      // The dashboard/chooser can hold the pre-create /v1/me/orgs payload after
      // POST /v1/org. Reloading forces OrgDashboardProvider.loadOrgDirectory()
      // (ee/apps/den-web/app/(den)/dashboard/_providers/org-dashboard-provider.tsx)
      // to re-read the organization directory before we search/click again.
      await ctx.eval("location.reload(); true");
      await ctx.waitFor(
        `Boolean(document.querySelector('[data-testid="org-chooser-list"]')) || location.pathname.startsWith('/dashboard')`,
        { timeoutMs: 60_000, label: "organization chooser or dashboard after reload" },
      );
    } else {
      await sleep(500);
    }
  }
  throw new EvalError(`Could not verify ${name} in Den Web UI after sign-in (${lastResult}).`);
}

async function browserActiveOrganization(ctx: FlowContext): Promise<BrowserOrganization | null> {
  const result = await ctx.eval(`fetch('/api/den/v1/org')
    .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => null) }))
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))`, { awaitPromise: true });
  if (!isRecord(result) || result.ok !== true || !isRecord(result.body)) return null;
  const organization = isRecord(result.body.organization) ? result.body.organization : null;
  if (!organization) return null;
  const id = stringField(organization, "id");
  const name = stringField(organization, "name");
  const slug = stringField(organization, "slug");
  return id && name ? { id, name, slug } : null;
}

async function setBrowserActiveOrganization(ctx: FlowContext, organizationId: string): Promise<void> {
  if (!organizationId) return;
  const result = await ctx.eval(`(async () => {
    const token = (window.localStorage.getItem(${JSON.stringify(AUTH_TOKEN_STORAGE_KEY)}) ?? '').trim();
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    const response = await fetch('/api/den/v1/me/active-organization', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ organizationId: ${JSON.stringify(organizationId)} }),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  })()`, { awaitPromise: true });
  if (!isRecord(result) || result.ok !== true) {
    const status = isRecord(result) ? String(result.status) : "unknown";
    const text = isRecord(result) ? stringField(result, "text") : "";
    throw new EvalError(`Could not set browser active organization ${organizationId}: ${status} ${text.slice(0, 300)}`);
  }
  await navigateAbsolute(ctx, `${denWebUrl(ctx)}/dashboard`, "dashboard after browser org switch");
}

async function setActiveOrganizationForToken(ctx: FlowContext, token: string, organizationId: string): Promise<void> {
  if (!organizationId) return;
  // Provenance: join-org-invite-clean.flow.mjs:121-132 uses
  // POST /v1/me/active-organization to pin bearer-token calls to the target org.
  const result = await denApiFetch(ctx, "/v1/me/active-organization", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ organizationId }),
  });
  if (!result.response.ok) {
    throw new EvalError(`Could not set active organization ${organizationId} for API session: ${result.response.status} ${result.text.slice(0, 300)}`);
  }
}

async function findPendingInvite(ctx: FlowContext, token: string, email: string, activeOrgId?: string): Promise<InviteRef> {
  const org = await denApiFetch(ctx, "/v1/org", { headers: orgScopedAuthHeaders(token, activeOrgId) });
  if (!org.response.ok) {
    throw new EvalError(`Could not load current organization invitations: ${org.response.status} ${org.text.slice(0, 300)}`);
  }
  return pendingInviteFromOrgBody(org.body, email);
}

async function createInviteViaApi(ctx: FlowContext, actor: Actor, email: string, role: string, activeOrgId?: string): Promise<InviteMemberResult> {
  const token = await apiSignIn(ctx, { actor });
  const organizationId = activeOrgId?.trim();
  if (organizationId) await setActiveOrganizationForToken(ctx, token, organizationId);
  // Provenance: invite-to-desktop.flow.mjs:510-529 and
  // first-connection.flow.mjs:541-554 create real invitations through
  // POST /v1/invitations and read inviteToken/invitationId.
  const created = await denApiFetch(ctx, "/v1/invitations", {
    method: "POST",
    headers: orgScopedAuthHeaders(token, organizationId),
    body: JSON.stringify({ email, role }),
  });
  if (!created.response.ok && created.response.status !== 502) {
    throw new EvalError(`Invitation failed for ${email}: ${created.response.status} ${created.text.slice(0, 500)}`);
  }
  const fromPayload = (() => {
    try {
      return extractInviteFromPayload(created.body, denWebUrl(ctx));
    } catch {
      return {};
    }
  })();
  const pending = fromPayload.token ? fromPayload : await findPendingInvite(ctx, token, email, organizationId);
  const tokenValue = pending.token ?? "";
  if (!tokenValue) {
    throw new EvalError(`Invitation for ${email} was created but no inviteToken could be resolved.`);
  }
  const inviteUrl = pending.inviteUrl ?? inviteUrlFromToken(denWebUrl(ctx), tokenValue);
  return {
    email,
    inviteUrl,
    token: tokenValue,
    invitationId: pending.invitationId || invitationIdFromBody(created.body),
    path: "api",
  };
}

async function tryInviteViaUi(ctx: FlowContext, email: string, role: string): Promise<boolean> {
  if (role !== DEFAULT_INVITE_ROLE) return false;
  const webUrl = denWebUrl(ctx);
  // Provenance: invite-to-desktop.flow.mjs:67-74 sends the invite through the
  // real Members UI: /dashboard/members -> Add member -> Send invite.
  await navigateAbsolute(ctx, `${webUrl}/dashboard/members`, "/dashboard/members");
  await ctx.waitFor("document.body.innerText.includes('Members') || document.body.innerText.includes('Add member')", {
    timeoutMs: 90_000,
    label: "Members page",
  });
  await clickExactText(ctx, "Add member", "button", 20_000);
  await ctx.waitFor("Boolean(document.querySelector('input[placeholder=\"teammate@example.com\"], input[type=\"email\"]'))", {
    timeoutMs: 20_000,
    label: "invite email input",
  });
  await ctx.fill('input[placeholder="teammate@example.com"], input[type="email"]', email);
  await clickExactText(ctx, "Send invite", "button", 20_000);
  await ctx.waitFor(`document.body.innerText.includes(${JSON.stringify(email)})`, { timeoutMs: 30_000, label: "pending invited email" });
  await ctx.waitFor("document.body.innerText.includes('Pending')", { timeoutMs: 20_000, label: "pending invite state" });
  return true;
}

async function resolvePendingInviteViaApi(ctx: FlowContext, actor: Actor, email: string, activeOrgId?: string): Promise<InviteMemberResult> {
  const token = await apiSignIn(ctx, { actor });
  const organizationId = activeOrgId?.trim();
  if (organizationId) await setActiveOrganizationForToken(ctx, token, organizationId);
  const pending = await findPendingInvite(ctx, token, email, organizationId);
  const tokenValue = pending.token ?? "";
  if (!tokenValue) {
    throw new EvalError(`Invitation for ${email} was sent through the Members UI but no pending inviteToken could be resolved.`);
  }
  return {
    email,
    inviteUrl: pending.inviteUrl ?? inviteUrlFromToken(denWebUrl(ctx), tokenValue),
    token: tokenValue,
    invitationId: pending.invitationId,
    path: "ui",
  };
}

async function markEmailVerifiedIfConfigured(ctx: FlowContext, email: string): Promise<boolean> {
  const command = ctx.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() ?? "";
  if (!command) return false;
  execSync(command.replaceAll("{email}", email), { stdio: "ignore" });
  ctx.log(`Marked ${email} verified via OPENWORK_EVAL_MARK_VERIFIED_CMD.`);
  return true;
}

async function waitForVerificationCodeFromDevOutbox(ctx: FlowContext, email: string): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const list = await denApiFetch(ctx, "/v1/dev/emails?template=verification");
    if (list.response.ok && normalizedEmail(firstDevEmailRecipient(list.body)) === normalizedEmail(email)) {
      const latest = await denApiFetch(ctx, "/v1/dev/emails/last?template=verification");
      if (latest.response.ok) {
        const code = verificationCodeFromHtml(latest.text);
        if (code) return code;
      }
    }
    await sleep(500);
  }
  return "";
}

async function submitVerificationCodeFromDevOutbox(ctx: FlowContext, email: string): Promise<boolean> {
  const code = await waitForVerificationCodeFromDevOutbox(ctx, email);
  if (!code) return false;
  await ctx.fill('input[inputmode="numeric"], input[pattern="[0-9]*"], input[type="text"]', code);
  await clickExactText(ctx, "Verify and join", "button", 20_000);
  await ctx.waitFor(
    `document.body.innerText.includes("You're one click away from the team workspace.")
      || Boolean(document.querySelector('[data-testid="join-org-success"]'))
      || location.pathname.startsWith('/dashboard')`,
    { timeoutMs: 60_000, label: `verified invitee email for ${email}` },
  );
  ctx.log(`Verified ${email} through the dev email outbox.`);
  return true;
}

async function requestBrowserVerificationCode(ctx: FlowContext, email: string): Promise<boolean> {
  const result = await ctx.eval(`(async () => {
    const response = await fetch('/api/auth/email-otp/send-verification-otp', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ${JSON.stringify(email)}, type: 'email-verification' }),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  })().catch((error) => ({ ok: false, status: 'fetch-error', text: error instanceof Error ? error.message : String(error) }))`, { awaitPromise: true });
  if (isRecord(result) && result.ok === true) return true;
  const text = isRecord(result) ? stringField(result, "text") : "";
  ctx.log(`Could not request verification code for ${email}: ${resultStatus(result)} ${text.slice(0, 200)}`);
  return false;
}

async function verifyBrowserEmailWithCode(ctx: FlowContext, email: string, code: string): Promise<boolean> {
  const result = await ctx.eval(`(async () => {
    const response = await fetch('/api/auth/email-otp/verify-email', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ${JSON.stringify(email)}, otp: ${JSON.stringify(code)} }),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  })().catch((error) => ({ ok: false, status: 'fetch-error', text: error instanceof Error ? error.message : String(error) }))`, { awaitPromise: true });
  if (isRecord(result) && result.ok === true) {
    ctx.log(`Verified ${email} through the browser session and dev email outbox.`);
    return true;
  }
  const text = isRecord(result) ? stringField(result, "text") : "";
  ctx.log(`Could not verify ${email} with the dev email code: ${resultStatus(result)} ${text.slice(0, 200)}`);
  return false;
}

async function verifyBrowserEmailFromDevOutbox(ctx: FlowContext, email: string): Promise<boolean> {
  if (!await requestBrowserVerificationCode(ctx, email)) return false;
  const code = await waitForVerificationCodeFromDevOutbox(ctx, email);
  if (!code) {
    ctx.log(`No dev verification email appeared for ${email}.`);
    return false;
  }
  return verifyBrowserEmailWithCode(ctx, email, code);
}

async function completeInviteVerificationIfNeeded(ctx: FlowContext, actor: Actor, inviteUrl: string): Promise<boolean> {
  if (!await ctx.hasText("Check your inbox.")) return false;
  const devVerified = await submitVerificationCodeFromDevOutbox(ctx, actor.email);
  if (devVerified) return true;
  const marked = await markEmailVerifiedIfConfigured(ctx, actor.email);
  if (!marked) throw new EvalError("Invite acceptance reached email verification; set OPENWORK_EVAL_MARK_VERIFIED_CMD or run against a dev stack with /v1/dev/emails enabled.");
  await navigateAbsolute(ctx, inviteUrl, "join org after verification");
  return true;
}

async function fillNameIfPresent(ctx: FlowContext, actor: Actor): Promise<void> {
  const hasName = await ctx.eval("Boolean(document.querySelector('input[name=\"name\"], input[autocomplete=\"name\"], input[type=\"text\"]'))");
  if (hasName) await ctx.fill('input[name="name"], input[autocomplete="name"], input[type="text"]', actor.name);
}

async function clickJoinButton(ctx: FlowContext): Promise<void> {
  await ctx.waitFor(`(() => {
    const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const button = [...document.querySelectorAll('button')]
      .find((entry) => normalize(entry.textContent).startsWith('Join ') && entry.disabled !== true && entry.getAttribute('aria-disabled') !== 'true');
    button?.scrollIntoView({ block: 'center', inline: 'center' });
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 30_000, label: "join organization button" });
}

async function waitForInviteAccepted(ctx: FlowContext, email: string, timeoutMs = 60_000): Promise<void> {
  await ctx.waitFor(
    `Boolean(document.querySelector('[data-testid="join-org-success"]'))
      || document.body.innerText.includes("You're in")
      || location.pathname.startsWith('/dashboard')`,
    { timeoutMs, label: `invite accepted for ${email}` },
  );
}

async function waitForPostClickInviteState(ctx: FlowContext, email: string): Promise<void> {
  await ctx.waitFor(
    `Boolean(document.querySelector('[data-testid="join-org-success"]'))
      || document.body.innerText.includes("You're in")
      || document.body.innerText.includes('Check your inbox.')
      || document.body.innerText.includes('Verify your email address before joining')
      || document.body.innerText.includes('Could not join the organization (403)')
      || Boolean(document.querySelector('[role="alert"]'))
      || location.pathname.startsWith('/dashboard')`,
    { timeoutMs: 60_000, label: `post-click invite state for ${email}` },
  );
}

async function visibleAlertText(ctx: FlowContext): Promise<string> {
  const result = await ctx.eval(`(() => {
    const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const alert = document.querySelector('[role="alert"]');
    return normalize(alert?.textContent ?? '');
  })()`);
  return typeof result === "string" ? result : "";
}

async function inviteAcceptedOnCurrentPage(ctx: FlowContext): Promise<boolean> {
  return await ctx.eval(`Boolean(document.querySelector('[data-testid="join-org-success"]'))
    || document.body.innerText.includes("You're in")
    || location.pathname.startsWith('/dashboard')`) === true;
}

async function handlePostClickInviteState(ctx: FlowContext, actor: Actor, inviteUrl: string): Promise<void> {
  if (await completeInviteVerificationIfNeeded(ctx, actor, inviteUrl)) return;
  if (await inviteAcceptedOnCurrentPage(ctx)) return;

  const bodyTextResult = await ctx.eval("document.body?.innerText ?? ''");
  const bodyText = typeof bodyTextResult === "string" ? bodyTextResult : "";
  const alertText = await visibleAlertText(ctx);
  const stateText = `${alertText}\n${bodyText}`;
  const needsVerification = stateText.includes("Verify your email address before joining")
    || stateText.includes("email_verification_required")
    || stateText.includes("Could not join the organization (403)");
  if (!needsVerification) {
    if (alertText) throw new EvalError(`Invite acceptance showed an error: ${alertText}`);
    return;
  }

  const verifiedThroughDevEmail = await verifyBrowserEmailFromDevOutbox(ctx, actor.email);
  const verified = verifiedThroughDevEmail || await markEmailVerifiedIfConfigured(ctx, actor.email);
  if (!verified) {
    throw new EvalError("Invite acceptance requires email verification; set OPENWORK_EVAL_MARK_VERIFIED_CMD or run against a dev stack with /v1/dev/emails enabled.");
  }

  await clickJoinButton(ctx);
  await waitForPostClickInviteState(ctx, actor.email);
  await completeInviteVerificationIfNeeded(ctx, actor, inviteUrl);
}

async function acceptInviteViaBrowserApi(ctx: FlowContext, inviteToken: string, webUrl: string): Promise<boolean> {
  if (!inviteToken) return false;
  const result = await ctx.eval(`(async () => {
    const response = await fetch('/api/den/v1/orgs/invitations/accept', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: ${JSON.stringify(inviteToken)} }),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  })()`, { awaitPromise: true });
  if (!isRecord(result) || result.ok !== true) {
    const status = isRecord(result) ? String(result.status) : "unknown";
    const text = isRecord(result) ? stringField(result, "text") : "";
    ctx.log(`Browser invite accept fallback failed: ${status} ${text.slice(0, 300)}`);
    return false;
  }
  ctx.log("Accepted the invite through the signed-in browser session after the UI button did not settle.");
  await navigateAbsolute(ctx, `${cleanBaseUrl(webUrl)}/dashboard`, "dashboard after browser invite accept");
  return true;
}

async function apiSignUpOrSignIn(ctx: FlowContext, actor: Actor): Promise<string> {
  const urls = resolveDenUrls(ctx.env);
  const authOrigin = ctx.env.OPENWORK_EVAL_DEN_AUTH_ORIGIN?.trim() || urls.webUrl;
  async function authRequest(path: string, body: string): Promise<DenApiFetchResult> {
    const headers = new Headers();
    headers.set("content-type", "application/json");
    headers.set("origin", authOrigin);
    const response = await fetch(`${urls.apiUrl}${path}`, { method: "POST", headers, body });
    const text = await response.text();
    return { response, text, body: parseJsonText(text) };
  }
  const signUpBody = JSON.stringify({ name: actor.name, email: actor.email, password: actor.password });
  const signedUp = await authRequest("/api/auth/sign-up/email", signUpBody);
  if (signedUp.response.ok && isRecord(signedUp.body) && typeof signedUp.body.token === "string" && signedUp.body.token.trim()) return signedUp.body.token;
  const signInBody = JSON.stringify({ email: actor.email, password: actor.password });
  const signedIn = await authRequest("/api/auth/sign-in/email", signInBody);
  if (signedIn.response.ok && isRecord(signedIn.body) && typeof signedIn.body.token === "string" && signedIn.body.token.trim()) return signedIn.body.token;
  throw new EvalError(`Could not sign up or sign in ${actor.email}: sign-up ${signedUp.response.status} ${signedUp.text.slice(0, 200)}; sign-in ${signedIn.response.status} ${signedIn.text.slice(0, 200)}`);
}

async function acceptInviteForActorViaApi(ctx: FlowContext, actor: Actor, inviteToken: string, webUrl: string): Promise<void> {
  const token = await apiSignUpOrSignIn(ctx, actor);
  const accepted = await denApiFetch(ctx, "/v1/orgs/invitations/accept", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ id: inviteToken }),
  });
  if (!accepted.response.ok) throw new EvalError(`API invite acceptance failed for ${actor.email}: ${accepted.response.status} ${accepted.text.slice(0, 300)}`);
  await ctx.eval(`(() => {
    window.localStorage.setItem(${JSON.stringify(AUTH_TOKEN_STORAGE_KEY)}, ${JSON.stringify(token)});
    window.location.href = ${JSON.stringify(`${cleanBaseUrl(webUrl)}/dashboard`)};
    return true;
  })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 45_000, label: "dashboard after API invite acceptance" });
  ctx.log(`Accepted invite for ${actor.email} through the Den API and opened the browser dashboard.`);
}

export async function signInWeb(ctx: FlowContext, options: SignInWebOptions): Promise<{ email: string; webUrl: string }> {
  const actor = validateActor(options.actor);
  await ctx.on(options.surface, async () => signInWebOnCurrentSurface(ctx, actor, true));
  return { email: actor.email, webUrl: denWebUrl(ctx) };
}

export async function signUpWeb(ctx: FlowContext, options: SignInWebOptions): Promise<{ email: string; webUrl: string }> {
  const actor = validateActor(options.actor);
  const webUrl = denWebUrl(ctx);
  await ctx.on(options.surface, async () => {
    // Provenance: new-signin-flow.flow.mjs:189-239 documents the email-first
    // sign-up surface: Start using OpenWork -> email -> Next -> Create your
    // account with name/password and Sign up.
    await clearDenWebSession(ctx, webUrl);
    await navigateAbsolute(ctx, webUrl, "den-web signup");
    await ctx.waitFor("Boolean(document.querySelector('input[type=\"email\"], input[name=\"email\"]')) || location.pathname.startsWith('/dashboard')", {
      timeoutMs: 30_000,
      label: "signup email field or dashboard",
    });
    if (await ctx.eval("location.pathname.startsWith('/dashboard')")) {
      await settleDashboard(ctx, true);
      return;
    }
    await ctx.fill('input[type="email"], input[name="email"]', actor.email);
    await clickExactText(ctx, "Next", "button", 20_000);
    await ctx.waitFor(
      `document.body.innerText.includes('Create your account.')
        || Boolean(document.querySelector('input[type="password"]'))
        || location.pathname.startsWith('/dashboard')`,
      { timeoutMs: 45_000, label: "signup details or dashboard" },
    );
    if (await ctx.eval("location.pathname.startsWith('/dashboard')")) {
      await settleDashboard(ctx, true);
      return;
    }
    await fillNameIfPresent(ctx, actor);
    await ctx.fill('input[type="password"]', actor.password);
    const createMode = await ctx.eval("document.body.innerText.includes('Create your account.')");
    await clickLastExactText(ctx, createMode ? "Sign up" : "Sign in", "button", 20_000);
    await settleDashboard(ctx, true);
  });
  return { email: actor.email, webUrl };
}

export async function createOrg(ctx: FlowContext, options: CreateOrgOptions): Promise<CreateOrgResult> {
  const actor = validateActor(options.actor);
  if (!options.name.trim()) throw new EvalError("createOrg requires a non-empty organization name.");
  const token = await apiSignIn(ctx, { actor });
  // Provenance: org-scope-pinning.flow.mjs:111-128 and
  // join-org-invite-clean.flow.mjs:134-149 use POST /v1/org when no Den Web UI
  // org-creation flow exists in coded evals; this journey keeps that API path
  // and adds browser chooser verification below.
  const created = await denApiFetch(ctx, "/v1/org", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ name: options.name }),
  });
  if (!created.response.ok) {
    throw new EvalError(`Creating organization ${options.name} failed: ${created.response.status} ${created.text.slice(0, 500)}`);
  }
  const organization = organizationFromPayload(created.body, options.name, options.slug);
  ctx.log(`Created organization ${organization.name} (${organization.id || organization.slug}) via API; verifying in Den Web chooser.`);
  await ctx.on(options.surface, async () => {
    await signInWebOnCurrentSurface(ctx, actor, false);
    if (organization.id) {
      await setBrowserActiveOrganization(ctx, organization.id);
      ctx.log(`Pinned ${organization.name} as the browser active organization through Den Web API state.`);
      return;
    }
    await chooseOrgByName(ctx, organization.name);
    const active = await browserActiveOrganization(ctx);
    if (organization.id && active?.id !== organization.id) {
      throw new EvalError(`Den Web active organization is ${active?.id ?? "unknown"}, expected ${organization.id}.`);
    }
  });
  return { orgId: organization.id || undefined, slug: organization.slug, name: organization.name, path: "api+ui-verify" };
}

export async function inviteMember(ctx: FlowContext, options: InviteMemberOptions): Promise<InviteMemberResult> {
  const actor = validateActor(options.actor);
  const role = options.role?.trim() || DEFAULT_INVITE_ROLE;
  const email = normalizedEmail(options.email);
  let activeOrgId = options.organizationId?.trim();
  if (!email) throw new EvalError("inviteMember requires an email address.");
  if (options.surface) {
    try {
      const activeOrg = await ctx.on(options.surface, async () => {
        if (activeOrgId) await setBrowserActiveOrganization(ctx, activeOrgId);
        const orgBefore = await browserActiveOrganization(ctx);
        if (!activeOrgId) activeOrgId = orgBefore?.id;
        await tryInviteViaUi(ctx, email, role);
        const orgAfter = await browserActiveOrganization(ctx);
        return orgAfter ?? orgBefore;
      });
      const result = await resolvePendingInviteViaApi(ctx, actor, email, activeOrgId || activeOrg?.id);
      ctx.log(`Invited ${email} through the Members UI and resolved its invite token from the pending invitation.`);
      return result;
    } catch (error) {
      ctx.log(`Members UI invite path failed; falling back to API invite for ${email}: ${messageText(error)}`);
    }
  }
  return createInviteViaApi(ctx, actor, email, role, activeOrgId);
}

export async function acceptInvite(ctx: FlowContext, options: AcceptInviteOptions): Promise<AcceptInviteResult> {
  const actor = validateActor(options.actor);
  const webUrl = denWebUrl(ctx);
  const allowApiFallback = options.allowApiFallback ?? true;
  const invite = options.invite.inviteUrl
    ? normalizeInviteUrl(options.invite.inviteUrl, webUrl)
    : options.invite.token
      ? { inviteUrl: inviteUrlFromToken(webUrl, options.invite.token), token: options.invite.token }
      : null;
  if (!invite?.inviteUrl) throw new EvalError("acceptInvite requires invite.inviteUrl or invite.token.");

  await ctx.on(options.surface, async () => {
    // Provenance: invite-to-desktop.flow.mjs:143-188 and :615-630 drive the
    // invitee browser through /join-org?invite=..., locked-email sign-up, the
    // one-click accept state, and the join success page. The verification
    // command remains optional because local dev stacks can skip verification.
    await clearDenWebSession(ctx, webUrl);
    await navigateAbsolute(ctx, invite.inviteUrl ?? "", "join org invite");
    await ctx.waitFor("document.body.innerText.includes('Join ') || Boolean(document.querySelector('[data-testid=\"join-org-root\"]'))", {
      timeoutMs: 45_000,
      label: "join organization screen",
    });

    const alreadySignedInAccept = await ctx.eval(`(() => {
      const text = document.body.innerText || '';
      return text.includes("You're one click away") || Boolean(document.querySelector('[data-testid="join-org-success"]'));
    })()`);
    if (!alreadySignedInAccept) {
      try {
        await ctx.waitFor(`(() => {
          const hasPassword = Boolean(document.querySelector('input[type="password"]'));
          const hasJoinSubmit = [...document.querySelectorAll('button')]
            .some((button) => (button.textContent ?? '').trim().startsWith('Join ') && button.disabled !== true);
          return hasPassword && hasJoinSubmit;
        })()`, { timeoutMs: 30_000, label: "invite sign-up form" });
      } catch (error) {
        if (!allowApiFallback) throw error;
        ctx.log(`Invite sign-up form did not appear for ${actor.email}; accepting through API: ${messageText(error)}`);
        await acceptInviteForActorViaApi(ctx, actor, invite.token ?? "", webUrl);
        return;
      }
      await fillNameIfPresent(ctx, actor);
      await ctx.fill('input[type="password"]', actor.password);
      await clickJoinButton(ctx);
      await ctx.waitFor(
        `document.body.innerText.includes("You're one click away from the team workspace.")
          || Boolean(document.querySelector('[data-testid="join-org-success"]'))
          || document.body.innerText.includes('Check your inbox.')`,
        { timeoutMs: 60_000, label: "post-signup invite state" },
      );
    }

    await completeInviteVerificationIfNeeded(ctx, actor, invite.inviteUrl ?? "");

    if (await ctx.hasText("You're one click away from the team workspace.")) {
      const verified = await markEmailVerifiedIfConfigured(ctx, actor.email);
      if (!verified) ctx.log("OPENWORK_EVAL_MARK_VERIFIED_CMD is not set; attempting invite acceptance directly (local dev may skip verification).");
      await clickJoinButton(ctx);
      await waitForPostClickInviteState(ctx, actor.email);
      await handlePostClickInviteState(ctx, actor, invite.inviteUrl ?? "");
    }

    if (await completeInviteVerificationIfNeeded(ctx, actor, invite.inviteUrl ?? "") && await ctx.hasText("You're one click away from the team workspace.")) {
      await clickJoinButton(ctx);
      await waitForPostClickInviteState(ctx, actor.email);
      await handlePostClickInviteState(ctx, actor, invite.inviteUrl ?? "");
    }

    try {
      await waitForInviteAccepted(ctx, actor.email, 15_000);
    } catch (error) {
      if (!allowApiFallback) throw error;
      const accepted = await acceptInviteViaBrowserApi(ctx, invite.token ?? "", webUrl);
      if (!accepted) throw error;
      await waitForInviteAccepted(ctx, actor.email);
    }
  });

  return { email: actor.email, inviteUrl: invite.inviteUrl, status: "accepted" };
}
