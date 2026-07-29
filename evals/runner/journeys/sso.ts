import { EvalError } from "../context.ts";
import type { FlowContext } from "../flow.ts";
import type { Surface } from "../surfaces.ts";
import {
  buildWrongDomainEmail,
  matchSsoExpectation,
  MOCK_IDP_BLOCKED_USER_PHRASE,
  normalizeMockIdpConfig,
  subjectWithKnobs,
  validateSsoConfiguration,
  type MockIdpConfig,
  type MockIdpSubjectInput,
  type NormalizedMockIdpConfig,
  type SsoExpectation,
  type SsoExpectationMatch,
  type StartedMockIdpLab,
} from "../labs/idp.ts";
import { cleanBaseUrl, denApiFetch, denWebUrl, inviteUrlFromToken, type DenApiFetchResult, type InviteRef } from "./den.ts";

const AUTH_TOKEN_STORAGE_KEY = "openwork:web:auth-token";
const SSO_STATE_KEY = "__ssoJourney";

export interface SsoOrganizationRef {
  id?: string;
  orgId?: string;
  organizationId?: string;
  slug?: string;
  token?: string;
}

export interface ConfigureOrgSsoOptions {
  org?: SsoOrganizationRef;
  idp: StartedMockIdpLab;
  overrides?: Partial<ReturnType<StartedMockIdpLab["registration"]>>;
}

export interface ConfiguredOrgSso {
  path: "den-api:/v1/sso/oidc";
  organizationId: string;
  organizationSlug: string;
  providerId: string;
  signInPath: string;
  signInUrl: string;
  registration: ReturnType<StartedMockIdpLab["registration"]>;
}

export interface ExpectSsoConfigErrorOptions {
  idp?: StartedMockIdpLab | NormalizedMockIdpConfig | MockIdpConfig;
  override: {
    cert?: string | null;
    certTrailingNewline?: boolean;
    wrongDomain?: boolean;
    subjectEmail?: string | null;
    configuredDomain?: string;
  };
  expect: SsoExpectation;
}

export interface SignInViaSsoOptions {
  surface?: string | Surface;
  subject: MockIdpSubjectInput;
  org?: SsoOrganizationRef;
  callbackUrl?: string;
  loginHint?: string;
  clearSession?: boolean;
}

export interface SsoBrowserResult {
  email: string;
  finalUrl: string;
  text: string;
}

export interface ExpectSsoBlockedUserMessageOptions extends SignInViaSsoOptions {}

export interface ExpectSsoScreenAfterLogoutOptions {
  surface?: string | Surface;
}

export interface ExpectInviteEmailPrevalidatedOptions {
  surface?: string | Surface;
  invite: InviteRef;
  subject: MockIdpSubjectInput;
  org?: SsoOrganizationRef;
}

interface ResolvedOrg {
  id: string;
  slug: string;
  token: string;
}

interface StoredSsoState {
  organizationId: string;
  organizationSlug: string;
  signInPath: string;
  signInUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authToken(ctx: FlowContext, org?: SsoOrganizationRef): string {
  const token = org?.token?.trim() || ctx.env.OPENWORK_EVAL_DEN_TOKEN?.trim() || "";
  if (!token) {
    throw new EvalError("OPENWORK_EVAL_DEN_TOKEN is required to configure the mock IdP through the Den SSO API.");
  }
  return token;
}

function organizationIdFromRef(org?: SsoOrganizationRef): string {
  return org?.organizationId?.trim() || org?.orgId?.trim() || org?.id?.trim() || "";
}

function authHeaders(token: string, organizationId?: string, cookie?: string): Headers {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${token}`);
  if (cookie) {
    headers.set("cookie", cookie);
  }
  if (organizationId) {
    headers.set("x-openwork-org-id", organizationId);
  }
  return headers;
}

function demoOwnerEmail(ctx: FlowContext): string {
  return ctx.env.DEN_DEMO_OWNER_EMAIL?.trim() || "alex@acme.test";
}

function demoOwnerPassword(ctx: FlowContext): string {
  return ctx.env.DEN_DEMO_OWNER_PASSWORD?.trim() || "OpenWorkDemo123!";
}

function sessionCookieFromHeader(value: string | null): string {
  const cookie = value?.split(";")[0]?.trim() || "";
  if (!cookie) {
    throw new EvalError("Den API sign-in did not return a Better Auth session cookie for SSO registration.");
  }
  return cookie;
}

async function demoOwnerSessionCookie(ctx: FlowContext): Promise<string> {
  const result = await denApiFetch(ctx, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: demoOwnerEmail(ctx), password: demoOwnerPassword(ctx) }),
  });
  if (!result.response.ok) {
    throw new EvalError(`Could not mint a Better Auth session cookie for SSO registration: ${result.response.status} ${result.text.slice(0, 300)}`);
  }
  return sessionCookieFromHeader(result.response.headers.get("set-cookie"));
}

async function clearExistingOrgSso(ctx: FlowContext, org: ResolvedOrg): Promise<void> {
  const result = await denApiFetch(ctx, "/v1/sso", {
    method: "DELETE",
    headers: authHeaders(org.token, org.id),
  });
  if (result.response.status !== 204 && result.response.status !== 404) {
    throw new EvalError(`Could not reset the existing SSO connection before lab registration: ${resultText(result)}`);
  }
}

export async function clearOrgSso(ctx: FlowContext, orgRef?: SsoOrganizationRef): Promise<void> {
  await clearExistingOrgSso(ctx, await resolveOrg(ctx, orgRef));
}

function connectionFromPayload(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || !isRecord(body.connection)) {
    return null;
  }
  return body.connection;
}

function organizationFromPayload(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || !isRecord(body.organization)) {
    return null;
  }
  return body.organization;
}

function inviteEmail(invite: InviteRef): string {
  return invite.email?.trim().toLowerCase() || "";
}

function requiredInviteUrl(invite: InviteRef, webUrl: string): string {
  if (invite.inviteUrl?.trim()) {
    return invite.inviteUrl.trim();
  }
  if (invite.token?.trim()) {
    return inviteUrlFromToken(webUrl, invite.token.trim());
  }
  throw new EvalError("expectInviteEmailPrevalidated requires invite.inviteUrl or invite.token.");
}

function storedSsoState(ctx: FlowContext): StoredSsoState | null {
  const value = ctx.state[SSO_STATE_KEY];
  if (!isRecord(value)) {
    return null;
  }
  const organizationId = stringField(value, "organizationId");
  const organizationSlug = stringField(value, "organizationSlug");
  const signInPath = stringField(value, "signInPath");
  const signInUrl = stringField(value, "signInUrl");
  if (!organizationSlug || !signInPath || !signInUrl) {
    return null;
  }
  return { organizationId, organizationSlug, signInPath, signInUrl };
}

function rememberSsoState(ctx: FlowContext, value: StoredSsoState): void {
  ctx.state[SSO_STATE_KEY] = value;
}

function configFromIdp(input: StartedMockIdpLab | NormalizedMockIdpConfig | MockIdpConfig | undefined): NormalizedMockIdpConfig {
  if (!input) {
    return normalizeMockIdpConfig();
  }
  if ("config" in input && isNormalizedMockIdpConfig(input.config)) {
    return input.config;
  }
  if (isNormalizedMockIdpConfig(input)) {
    return input;
  }
  return normalizeMockIdpConfig(input);
}

function isNormalizedMockIdpConfig(value: unknown): value is NormalizedMockIdpConfig {
  if (!isRecord(value) || !isRecord(value.defaultSubject) || !isRecord(value.knobs)) {
    return false;
  }
  return typeof value.issuer === "string"
    && typeof value.domain === "string"
    && typeof value.clientId === "string"
    && typeof value.clientSecret === "string"
    && typeof value.defaultSubject.email === "string"
    && typeof value.defaultSubject.sub === "string"
    && typeof value.defaultSubject.name === "string";
}

function certificateFromIdp(input: StartedMockIdpLab | NormalizedMockIdpConfig | MockIdpConfig | undefined): string | null {
  if (input && "certificate" in input && typeof input.certificate === "string") {
    return input.certificate;
  }
  return null;
}

async function ensureReadyState(ctx: FlowContext, label: string): Promise<void> {
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 60_000, label });
}

async function navigateAbsolute(ctx: FlowContext, url: string, label: string): Promise<void> {
  const safeUrl = new URL(url).toString();
  const client = ctx.client;
  if (!client) throw new EvalError(`Cannot navigate to ${label}: no CDP client is attached to this surface.`);
  // Structured CDP navigation only — never construct code from a URL.
  await client.send("Page.navigate", { url: safeUrl });
  await ensureReadyState(ctx, `load ${label}`);
}

async function visibleText(ctx: FlowContext): Promise<string> {
  const text = await ctx.eval("document.body?.innerText ?? ''");
  return typeof text === "string" ? text : "";
}

async function currentHref(ctx: FlowContext): Promise<string> {
  const href = await ctx.eval("location.href");
  return typeof href === "string" ? href : "";
}

async function clearBrowserSession(ctx: FlowContext, webUrl: string): Promise<void> {
  await navigateAbsolute(ctx, webUrl, "Den Web before SSO sign-out");
  await ctx.eval(`(() => {
    window.localStorage.removeItem(${JSON.stringify(AUTH_TOKEN_STORAGE_KEY)});
    window.sessionStorage.clear();
    return Promise.allSettled([
      fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' }),
      fetch('/api/den/api/auth/sign-out', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' }),
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

async function resolveOrg(ctx: FlowContext, org?: SsoOrganizationRef): Promise<ResolvedOrg> {
  const token = authToken(ctx, org);
  const requestedOrganizationId = organizationIdFromRef(org);
  const response = await denApiFetch(ctx, "/v1/org", {
    headers: authHeaders(token, requestedOrganizationId),
  });
  if (!response.response.ok) {
    throw new EvalError(`Could not resolve active organization for SSO configuration: ${response.response.status} ${response.text.slice(0, 300)}`);
  }
  const organization = organizationFromPayload(response.body);
  if (!organization) {
    throw new EvalError(`Active organization response did not include an organization: ${JSON.stringify(response.body).slice(0, 300)}`);
  }
  const id = requestedOrganizationId || stringField(organization, "id");
  const slug = org?.slug?.trim() || stringField(organization, "slug");
  if (!id || !slug) {
    throw new EvalError(`Active organization response did not include id and slug: ${JSON.stringify(response.body).slice(0, 300)}`);
  }
  return { id, slug, token };
}

function resultText(result: DenApiFetchResult): string {
  return `${result.response.status} ${result.text.slice(0, 500)}`;
}

export async function configureOrgSso(ctx: FlowContext, options: ConfigureOrgSsoOptions): Promise<ConfiguredOrgSso> {
  const org = await resolveOrg(ctx, options.org);
  const registration = options.idp.registration(options.overrides);
  await clearExistingOrgSso(ctx, org);
  const cookie = await demoOwnerSessionCookie(ctx);
  const result = await denApiFetch(ctx, "/v1/sso/oidc", {
    method: "POST",
    headers: authHeaders(org.token, org.id, cookie),
    body: JSON.stringify({
      issuer: registration.issuer,
      domain: registration.domain,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      scopes: registration.scopes,
      skipDiscovery: registration.skipDiscovery,
      authorizationEndpoint: registration.authorizationEndpoint,
      tokenEndpoint: registration.tokenEndpoint,
      jwksEndpoint: registration.jwksEndpoint,
      userInfoEndpoint: registration.userInfoEndpoint,
      tokenEndpointAuthentication: registration.tokenEndpointAuthentication,
    }),
  });
  if (!result.response.ok) {
    throw new EvalError(`Registering mock OIDC SSO through Den API /v1/sso/oidc failed: ${resultText(result)}`);
  }
  const connection = connectionFromPayload(result.body);
  if (!connection) {
    throw new EvalError(`SSO registration response did not include a connection: ${JSON.stringify(result.body).slice(0, 500)}`);
  }
  const signInPath = stringField(connection, "signInPath") || `/sso/${encodeURIComponent(org.slug)}`;
  const signInUrl = stringField(connection, "signInUrl") || new URL(signInPath, `${denWebUrl(ctx)}/`).toString();
  const configured: ConfiguredOrgSso = {
    path: "den-api:/v1/sso/oidc",
    organizationId: org.id,
    organizationSlug: org.slug,
    providerId: stringField(connection, "providerId"),
    signInPath,
    signInUrl,
    registration,
  };
  rememberSsoState(ctx, {
    organizationId: configured.organizationId,
    organizationSlug: configured.organizationSlug,
    signInPath: configured.signInPath,
    signInUrl: configured.signInUrl,
  });
  ctx.log(`Configured mock OIDC SSO through Den API /v1/sso/oidc for ${org.slug}.`);
  return configured;
}

export async function expectSsoConfigError(ctx: FlowContext, options: ExpectSsoConfigErrorOptions): Promise<SsoExpectationMatch> {
  const config = configFromIdp(options.idp);
  const baseCert = certificateFromIdp(options.idp) ?? "-----BEGIN CERTIFICATE-----\nmock\n-----END CERTIFICATE-----";
  const cert = options.override.cert !== undefined
    ? options.override.cert
    : options.override.certTrailingNewline
      ? `${baseCert.replace(/(?:\r?\n)+$/g, "")}\n`
      : baseCert.replace(/(?:\r?\n)+$/g, "");
  const subjectEmail = options.override.subjectEmail !== undefined
    ? options.override.subjectEmail
    : options.override.wrongDomain
      ? buildWrongDomainEmail(config.defaultSubject.email, config.domain)
      : config.defaultSubject.email;
  const validation = validateSsoConfiguration({
    configuredDomain: options.override.configuredDomain ?? config.domain,
    cert,
    subjectEmail,
  });
  const match = matchSsoExpectation(validation, options.expect);
  ctx.recordEvidence({
    type: "assertion",
    status: match.passed ? "passed" : "failed",
    assertion: `SSO config error is named and actionable: ${options.expect.code}`,
    actual: {
      expected: options.expect,
      validation,
      match,
    },
  });
  if (!match.passed) {
    throw new EvalError(match.detail);
  }
  return match;
}

function signInUrl(ctx: FlowContext, org?: SsoOrganizationRef): string {
  const stored = storedSsoState(ctx);
  const slug = org?.slug?.trim() || stored?.organizationSlug;
  if (!slug) {
    throw new EvalError("No SSO organization slug is available. Call configureOrgSso first or pass org.slug.");
  }
  const path = stored?.signInPath || `/sso/${encodeURIComponent(slug)}`;
  return new URL(path, `${denWebUrl(ctx)}/`).toString();
}

async function signInViaSsoOnCurrentSurface(ctx: FlowContext, options: SignInViaSsoOptions): Promise<SsoBrowserResult> {
  const webUrl = denWebUrl(ctx);
  if (options.clearSession !== false) {
    await clearBrowserSession(ctx, webUrl);
  }
  const target = new URL(signInUrl(ctx, options.org));
  target.searchParams.set("callbackURL", options.callbackUrl ?? new URL("/dashboard", `${webUrl}/`).toString());
  const loginHint = options.loginHint?.trim() || options.subject.email?.trim() || "";
  if (loginHint) {
    target.searchParams.set("loginHint", loginHint);
  }
  await navigateAbsolute(ctx, target.toString(), "organization SSO sign-in");
  await ctx.waitFor(`(() => {
    const text = document.body?.innerText ?? '';
    return location.pathname.startsWith('/dashboard')
      || location.pathname.startsWith('/join-org')
      || location.hostname === '127.0.0.1'
      || text.includes(${JSON.stringify(MOCK_IDP_BLOCKED_USER_PHRASE)})
      || text.includes('Dashboard')
      || text.includes('Could not')
      || text.includes('Join ');
  })()`, { timeoutMs: 90_000, label: "SSO browser reached terminal state" });
  if (!options.callbackUrl) {
    const href = await currentHref(ctx);
    const webOrigin = cleanBaseUrl(webUrl);
    if (href.startsWith(webOrigin) && !href.includes("/dashboard")) {
      await navigateAbsolute(ctx, new URL("/dashboard", `${webUrl}/`).toString(), "dashboard after SSO");
      await ctx.waitFor("document.body.innerText.includes('Dashboard') || location.pathname.startsWith('/dashboard')", {
        timeoutMs: 60_000,
        label: "dashboard after SSO",
      });
    }
  }
  return {
    email: options.subject.email?.trim().toLowerCase() || loginHint.toLowerCase(),
    finalUrl: await currentHref(ctx),
    text: await visibleText(ctx),
  };
}

export async function signInViaSso(ctx: FlowContext, options: SignInViaSsoOptions): Promise<SsoBrowserResult> {
  if (options.surface) {
    return ctx.on(options.surface, () => signInViaSsoOnCurrentSurface(ctx, options));
  }
  return signInViaSsoOnCurrentSurface(ctx, options);
}

export async function expectSsoBlockedUserMessage(ctx: FlowContext, options: ExpectSsoBlockedUserMessageOptions): Promise<SsoBrowserResult> {
  const result = await signInViaSso(ctx, options);
  const text = result.text.toLowerCase();
  const passed = text.includes(MOCK_IDP_BLOCKED_USER_PHRASE) && text.includes("identity provider") && text.includes("policy");
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion: "Blocked SSO user sees an actionable identity-provider policy message",
    actual: { finalUrl: result.finalUrl, text: result.text.slice(0, 1000) },
  });
  if (!passed) {
    throw new EvalError(`Expected blocked-user IdP policy message, got: ${result.text.slice(0, 500)}`);
  }
  return result;
}

async function expectSsoScreenAfterLogoutOnCurrentSurface(ctx: FlowContext): Promise<string> {
  const webUrl = denWebUrl(ctx);
  await ctx.eval(`(() => Promise.allSettled([
    fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' }),
    fetch('/api/den/api/auth/sign-out', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' }),
  ]).then(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.location.href = ${JSON.stringify(webUrl)};
    return true;
  }))()`, { awaitPromise: true });
  await ensureReadyState(ctx, "SSO screen after logout");
  await ctx.waitFor("document.body.innerText.includes('Continue with SSO') || document.body.innerText.includes('Sign in with SSO')", {
    timeoutMs: 60_000,
    label: "SSO screen after logout",
  });
  const text = await visibleText(ctx);
  const legacyPassword = text.includes("Password") || text.includes("Forgot password?");
  const passed = (text.includes("Continue with SSO") || text.includes("Sign in with SSO")) && !legacyPassword;
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion: "Logout returns to the SSO screen instead of the legacy email/password login page",
    actual: text.slice(0, 1000),
  });
  if (!passed) {
    throw new EvalError(`Logout did not return to an SSO-only screen: ${text.slice(0, 500)}`);
  }
  return text;
}

export async function expectSsoScreenAfterLogout(ctx: FlowContext, options: ExpectSsoScreenAfterLogoutOptions): Promise<string> {
  if (options.surface) {
    return ctx.on(options.surface, () => expectSsoScreenAfterLogoutOnCurrentSurface(ctx));
  }
  return expectSsoScreenAfterLogoutOnCurrentSurface(ctx);
}

async function clickJoinIfPresent(ctx: FlowContext): Promise<boolean> {
  const clicked = await ctx.eval(`(() => {
    const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const button = [...document.querySelectorAll('button')]
      .find((entry) => normalize(entry.textContent).startsWith('Join ') && entry.disabled !== true && entry.getAttribute('aria-disabled') !== 'true');
    button?.scrollIntoView({ block: 'center', inline: 'center' });
    button?.click();
    return Boolean(button);
  })()`);
  return clicked === true;
}

function hasCoherentInviteMismatchCopy(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("does not match")
    || normalized.includes("invited email")
    || normalized.includes("this invite is for")
    || normalized.includes("not invited")
    || normalized.includes("could not join")
    || normalized.includes("switch accounts to continue")
    || normalized.includes("use the invited email");
}

async function expectInviteEmailPrevalidatedOnCurrentSurface(ctx: FlowContext, options: ExpectInviteEmailPrevalidatedOptions): Promise<SsoBrowserResult> {
  const webUrl = denWebUrl(ctx);
  const callbackUrl = requiredInviteUrl(options.invite, webUrl);
  const loginHint = inviteEmail(options.invite);
  const result = await signInViaSsoOnCurrentSurface(ctx, {
    subject: options.subject,
    org: options.org,
    callbackUrl,
    loginHint,
  });
  if (await clickJoinIfPresent(ctx)) {
    await ctx.waitFor(`(() => {
      const text = document.body?.innerText ?? '';
      return Boolean(document.querySelector('[role="alert"]'))
        || text.includes('Could not join')
        || text.includes('does not match')
        || text.includes('invited email')
        || location.pathname.startsWith('/dashboard');
    })()`, { timeoutMs: 45_000, label: "invite mismatch post-join state" }).catch(async () => {
      await sleep(1_000);
      return true;
    });
  }
  const finalUrl = await currentHref(ctx);
  const text = await visibleText(ctx);
  const lowerUrl = finalUrl.toLowerCase();
  const looped = lowerUrl.includes("/sso/") || text.includes("Signing you in");
  const landedDashboard = lowerUrl.includes("/dashboard") || text.includes("Dashboard");
  const coherent = hasCoherentInviteMismatchCopy(text);
  ctx.recordEvidence({
    type: "assertion",
    status: !looped ? "passed" : "failed",
    assertion: "Invite mismatch SSO flow does not loop back through SSO",
    actual: { finalUrl, text: text.slice(0, 600) },
  });
  ctx.recordEvidence({
    type: "assertion",
    status: !landedDashboard && coherent ? "passed" : "failed",
    assertion: "Invite mismatch is rejected coherently before accepting the invite",
    actual: { finalUrl, expectedInviteEmail: loginHint, actualSubject: options.subject.email, text: text.slice(0, 1000) },
  });
  if (looped) {
    throw new EvalError(`Invite mismatch looped instead of stopping: ${finalUrl}`);
  }
  if (landedDashboard || !coherent) {
    throw new EvalError(`Invite mismatch was not coherently rejected. Dashboard=${landedDashboard}; text=${text.slice(0, 500)}`);
  }
  return { ...result, finalUrl, text };
}

export async function expectInviteEmailPrevalidated(ctx: FlowContext, options: ExpectInviteEmailPrevalidatedOptions): Promise<SsoBrowserResult> {
  if (options.surface) {
    return ctx.on(options.surface, () => expectInviteEmailPrevalidatedOnCurrentSurface(ctx, options));
  }
  return expectInviteEmailPrevalidatedOnCurrentSurface(ctx, options);
}

export function previewSubjectForConfig(config: MockIdpConfig): MockIdpSubjectInput {
  const normalized = normalizeMockIdpConfig(config);
  return subjectWithKnobs(normalized);
}
