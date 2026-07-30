import { createPublicKey, createSign, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { trimTrailingSlashes } from "./strings.ts";

const DEFAULT_DOMAIN = "acme.test";
const DEFAULT_CLIENT_ID = "openwork-eval-oidc-client";
const DEFAULT_CLIENT_SECRET = "openwork-eval-oidc-secret";
const DEFAULT_ISSUER = "http://127.0.0.1/mock-openwork-idp";
const DEFAULT_EVAL_ISSUER = "http://127.0.0.1:19190";
const DEFAULT_GROUPS = ["Engineering", "OpenWork Lab"];
const DEFAULT_ROLE = "member";

export const MOCK_IDP_BLOCKED_USER_PHRASE = "administrator has configured the application to block users";

export type MockGroupClaims =
  | "present"
  | "absent"
  | "unexpected-shape"
  | readonly string[]
  | {
      claim: string;
      values: readonly string[];
    };

export interface MockIdpKnobs {
  certTrailingNewline?: boolean;
  wrongDomain?: boolean;
  blockedUser?: string;
  groupClaims?: MockGroupClaims;
  emailMismatch?: boolean | string;
  guestUser?: boolean;
}

export interface MockIdpSubjectInput {
  sub?: string;
  email?: string;
  name?: string;
}

export interface MockIdpSubject {
  sub: string;
  email: string;
  name: string;
}

export interface MockIdpConfig {
  issuer?: string;
  domain?: string;
  clientId?: string;
  clientSecret?: string;
  defaultSubject?: MockIdpSubjectInput;
  knobs?: MockIdpKnobs;
}

export interface NormalizedMockIdpKnobs {
  certTrailingNewline: boolean;
  wrongDomain: boolean;
  blockedUser: string | null;
  groupClaims: MockGroupClaims;
  emailMismatch: boolean | string;
  guestUser: boolean;
}

export interface NormalizedMockIdpConfig {
  issuer: string;
  domain: string;
  clientId: string;
  clientSecret: string;
  defaultSubject: MockIdpSubject;
  knobs: NormalizedMockIdpKnobs;
}

export interface MockOidcRegistration {
  kind: "oidc";
  issuer: string;
  domain: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  skipDiscovery: boolean;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  userInfoEndpoint: string;
  tokenEndpointAuthentication: "client_secret_post";
}

export interface MockSamlEndpoints {
  metadataUrl: string;
  ssoPostUrl: string;
  certificate: string;
}

export interface StartedMockIdpLab {
  protocol: "oidc";
  config: NormalizedMockIdpConfig;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  userInfoEndpoint: string;
  saml: MockSamlEndpoints;
  keyId: string;
  certificate: string;
  publicKeyPem: string;
  registration(overrides?: Partial<MockOidcRegistration>): MockOidcRegistration;
  claimsFor(subject?: MockIdpSubjectInput): Record<string, unknown>;
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

interface KeyMaterial {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  jwk: Record<string, unknown>;
}

interface AuthorizationCodeRecord {
  clientId: string;
  nonce: string | null;
  redirectUri: string;
  subject: MockIdpSubject;
}

interface MockIdpState {
  config: NormalizedMockIdpConfig;
  keys: KeyMaterial;
  codes: Map<string, AuthorizationCodeRecord>;
  accessTokens: Map<string, Record<string, unknown>>;
}

export type SsoConfigErrorCode = "sso_cert_trailing_newline" | "sso_domain_mismatch";

export interface NormalizedCertificateMaterial {
  value: string;
  hadTrailingNewline: boolean;
}

export interface SsoConfigurationValidationInput {
  configuredDomain: string;
  cert?: string | null;
  subjectEmail?: string | null;
}

export interface SsoConfigurationError {
  code: SsoConfigErrorCode;
  message: string;
  detail: string;
}

export interface SsoConfigurationValidation {
  ok: boolean;
  errors: SsoConfigurationError[];
  normalizedDomain: string;
  normalizedCert?: string;
}

export interface SsoExpectation {
  code: SsoConfigErrorCode;
  includes?: readonly string[];
}

export interface SsoExpectationMatch {
  passed: boolean;
  expectedCode: SsoConfigErrorCode;
  actualCodes: string[];
  detail: string;
}

export interface Rs256SigningArgvInput {
  keyId: string;
  payload: string;
}

export interface BlockedUserResponseShape {
  status: 403;
  error: "access_denied";
  errorDescription: string;
  message: string;
  html: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddressInfo(value: ReturnType<Server["address"]>): value is AddressInfo {
  return typeof value === "object"
    && value !== null
    && typeof value.address === "string"
    && typeof value.family === "string"
    && typeof value.port === "number";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNamedGroupClaim(value: MockGroupClaims): value is { claim: string; values: readonly string[] } {
  return isRecord(value) && typeof value.claim === "string" && isStringArray(value.values);
}

function cleanIssuer(value: string | undefined): string {
  const trimmed = trimTrailingSlashes((value ?? DEFAULT_ISSUER).trim());
  return trimmed || DEFAULT_ISSUER;
}

function requestedIssuer(value: string | undefined): URL | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(cleanIssuer(trimmed));
    return url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function configuredMockIdpIssuer(input: MockIdpConfig): URL | null {
  const evalIssuer = process.env.OPENWORK_EVAL_DEN_API_URL?.trim() ? DEFAULT_EVAL_ISSUER : undefined;
  return requestedIssuer(input.issuer) ?? requestedIssuer(process.env.OPENWORK_EVAL_MOCK_IDP_ISSUER) ?? requestedIssuer(evalIssuer);
}

export function normalizeDomain(value: string | undefined): string {
  const input = (value ?? DEFAULT_DOMAIN).trim().toLowerCase();
  let start = 0;
  let end = input.length;
  while (start < end && input[start] === "@") start += 1;
  while (end > start && input[end - 1] === ".") end -= 1;
  const normalized = input.slice(start, end);
  return normalized || DEFAULT_DOMAIN;
}

export function emailDomain(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase() ?? "";
  const at = value.lastIndexOf("@");
  if (at < 0 || at === value.length - 1) {
    return null;
  }
  return normalizeDomain(value.slice(at + 1));
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : "sso.user";
}

export function buildWrongDomainEmail(email: string, configuredDomain: string): string {
  return `${localPart(email)}@wrong-${normalizeDomain(configuredDomain)}`;
}

function defaultSubject(domain: string): MockIdpSubject {
  const email = `sso.user@${domain}`;
  return {
    sub: email,
    email,
    name: "OpenWork SSO User",
  };
}

function normalizeSubject(input: MockIdpSubjectInput | undefined, domain: string): MockIdpSubject {
  const fallback = defaultSubject(domain);
  const email = input?.email?.trim().toLowerCase() || fallback.email;
  return {
    sub: input?.sub?.trim() || email,
    email,
    name: input?.name?.trim() || fallback.name,
  };
}

function normalizeKnobs(knobs: MockIdpKnobs | undefined): NormalizedMockIdpKnobs {
  return {
    certTrailingNewline: knobs?.certTrailingNewline === true,
    wrongDomain: knobs?.wrongDomain === true,
    blockedUser: knobs?.blockedUser?.trim() || null,
    groupClaims: knobs?.groupClaims ?? "present",
    emailMismatch: knobs?.emailMismatch ?? false,
    guestUser: knobs?.guestUser === true,
  };
}

export function normalizeMockIdpConfig(input: MockIdpConfig = {}): NormalizedMockIdpConfig {
  const domain = normalizeDomain(input.domain);
  return {
    issuer: cleanIssuer(input.issuer),
    domain,
    clientId: input.clientId?.trim() || DEFAULT_CLIENT_ID,
    clientSecret: input.clientSecret?.trim() || DEFAULT_CLIENT_SECRET,
    defaultSubject: normalizeSubject(input.defaultSubject, domain),
    knobs: normalizeKnobs(input.knobs),
  };
}

export function normalizeCertificateMaterial(value: string | null | undefined): NormalizedCertificateMaterial {
  const raw = value ?? "";
  let end = raw.length;
  while (end > 0 && raw[end - 1] === "\n") {
    end -= 1;
    if (end > 0 && raw[end - 1] === "\r") end -= 1;
  }
  return {
    value: raw.slice(0, end),
    hadTrailingNewline: end !== raw.length,
  };
}

export function validateSsoConfiguration(input: SsoConfigurationValidationInput): SsoConfigurationValidation {
  const normalizedDomain = normalizeDomain(input.configuredDomain);
  const errors: SsoConfigurationError[] = [];
  const cert = normalizeCertificateMaterial(input.cert);
  if (input.cert !== undefined && input.cert !== null && cert.hadTrailingNewline) {
    errors.push({
      code: "sso_cert_trailing_newline",
      message: "SSO certificate has trailing newline characters. Remove the blank line at the end of the pasted certificate and save again.",
      detail: "The field POC failure was a certificate paste with a trailing newline; this matcher names it instead of surfacing a generic SSO failure.",
    });
  }

  const subjectDomain = emailDomain(input.subjectEmail);
  if (subjectDomain && subjectDomain !== normalizedDomain) {
    errors.push({
      code: "sso_domain_mismatch",
      message: `SSO domain mismatch: IdP email domain ${subjectDomain} does not match configured organization domain ${normalizedDomain}.`,
      detail: "The IdP subject email domain must match the organization SSO domain before users are sent through the provider.",
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    normalizedDomain,
    normalizedCert: input.cert === undefined || input.cert === null ? undefined : cert.value,
  };
}

export function matchSsoExpectation(validation: SsoConfigurationValidation, expectation: SsoExpectation): SsoExpectationMatch {
  const match = validation.errors.find((error) => error.code === expectation.code) ?? null;
  const includes = expectation.includes ?? [];
  const haystack = match ? `${match.message}\n${match.detail}` : "";
  const missing = includes.filter((needle) => !haystack.toLowerCase().includes(needle.toLowerCase()));
  const passed = Boolean(match) && missing.length === 0;
  return {
    passed,
    expectedCode: expectation.code,
    actualCodes: validation.errors.map((error) => error.code),
    detail: passed
      ? match?.message ?? expectation.code
      : `Expected ${expectation.code}${missing.length ? ` with text ${missing.join(", ")}` : ""}; got ${validation.errors.map((error) => error.code).join(", ") || "no errors"}.`,
  };
}

export function buildRs256SigningArgv(input: Rs256SigningArgvInput): readonly string[] {
  return [
    "node:crypto",
    "createSign",
    "RSA-SHA256",
    "--kid",
    input.keyId,
    "--payload-bytes",
    String(Buffer.byteLength(input.payload, "utf8")),
  ];
}

export function subjectWithKnobs(config: NormalizedMockIdpConfig, input?: MockIdpSubjectInput): MockIdpSubject {
  const requested = normalizeSubject(input, config.domain);
  let email = requested.email;
  if (config.knobs.emailMismatch) {
    email = typeof config.knobs.emailMismatch === "string" && config.knobs.emailMismatch.trim()
      ? config.knobs.emailMismatch.trim().toLowerCase()
      : `mismatch.${localPart(requested.email)}@${config.domain}`;
  }
  if (config.knobs.wrongDomain) {
    email = buildWrongDomainEmail(email, config.domain);
  }
  if (config.knobs.guestUser) {
    email = input?.email?.trim().toLowerCase() || `guest.user@external.${config.domain}`;
  }
  return {
    sub: input?.sub?.trim() || (config.knobs.guestUser ? `guest:${email}` : email),
    email,
    name: input?.name?.trim() || requested.name,
  };
}

function secondsSinceEpoch(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function applyGroupClaims(claims: Record<string, unknown>, groupClaims: MockGroupClaims): void {
  if (groupClaims === "absent") {
    return;
  }
  if (groupClaims === "unexpected-shape") {
    claims.groups = { primary: DEFAULT_GROUPS[0], all: DEFAULT_GROUPS };
    claims.roles = { default: DEFAULT_ROLE };
    return;
  }
  if (isStringArray(groupClaims)) {
    claims.groups = [...groupClaims];
    claims.roles = [DEFAULT_ROLE];
    return;
  }
  if (isNamedGroupClaim(groupClaims)) {
    claims[groupClaims.claim] = [...groupClaims.values];
    claims.roles = [DEFAULT_ROLE];
    return;
  }
  claims.groups = [...DEFAULT_GROUPS];
  claims.roles = [DEFAULT_ROLE];
}

export function buildOidcClaims(input: {
  issuer: string;
  clientId: string;
  subject: MockIdpSubject;
  nonce?: string | null;
  now?: Date;
  expiresInSeconds?: number;
  knobs?: NormalizedMockIdpKnobs;
}): Record<string, unknown> {
  const now = input.now ?? new Date();
  const issuedAt = secondsSinceEpoch(now);
  const knobs = input.knobs ?? normalizeKnobs(undefined);
  const claims: Record<string, unknown> = {
    iss: cleanIssuer(input.issuer),
    sub: input.subject.sub,
    aud: input.clientId,
    iat: issuedAt,
    exp: issuedAt + (input.expiresInSeconds ?? 300),
    email: input.subject.email,
    email_verified: true,
    name: input.subject.name,
    preferred_username: input.subject.email,
    picture: `https://avatar.openwork.test/${encodeURIComponent(input.subject.email)}`,
    department: "Enterprise Lab",
  };
  if (input.nonce) {
    claims.nonce = input.nonce;
  }
  if (knobs.guestUser) {
    claims.userType = "Guest";
    claims.tenant_hint = "external";
  }
  applyGroupClaims(claims, knobs.groupClaims);
  return claims;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function signOidcJwt(input: {
  keyId: string;
  privateKeyPem: string;
  claims: Record<string, unknown>;
}): string {
  const header = base64UrlJson({ alg: "RS256", typ: "JWT", kid: input.keyId });
  const payload = base64UrlJson(input.claims);
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(input.privateKeyPem).toString("base64url");
  return `${signingInput}.${signature}`;
}

function publicJwk(publicKeyPem: string, keyId: string): Record<string, unknown> {
  const exported = createPublicKey(publicKeyPem).export({ format: "jwk" });
  const jwk: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(exported)) {
    jwk[name] = value;
  }
  jwk.kid = keyId;
  jwk.use = "sig";
  jwk.alg = "RS256";
  return jwk;
}

function createKeyMaterial(): KeyMaterial {
  const keyPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const keyId = `mock-idp-${randomBytes(6).toString("hex")}`;
  return {
    keyId,
    privateKeyPem: keyPair.privateKey,
    publicKeyPem: keyPair.publicKey,
    jwk: publicJwk(keyPair.publicKey, keyId),
  };
}

function certificateFromPublicKey(publicKeyPem: string, trailingNewline: boolean): string {
  const body = publicKeyPem
    .split(/\r?\n/g)
    .filter((line) => line && !line.startsWith("-----"))
    .join("\n");
  const cert = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
  return trailingNewline ? `${cert}\n` : cert;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// A single global character-class replace: linear (no backtracking) and the
// shape static analysis recognises as HTML escaping, unlike a chain of
// string-pattern replaceAll calls.
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);
}

export function buildBlockedUserResponse(subject: MockIdpSubjectInput, policyName = "OpenWork Mock IdP policy"): BlockedUserResponseShape {
  const label = subject.email?.trim() || subject.sub?.trim() || "this user";
  const errorDescription = `The ${MOCK_IDP_BLOCKED_USER_PHRASE} unless they are assigned to the enterprise application.`;
  const message = `${policyName} blocked ${label}. ${errorDescription} Ask an IdP administrator to assign the user or update the app assignment policy.`;
  return {
    status: 403,
    error: "access_denied",
    errorDescription,
    message,
    html: `<!doctype html><html><head><title>OpenWork Mock IdP policy block</title></head><body><main style="font-family: sans-serif; max-width: 720px; margin: 48px auto;"><p>OpenWork Mock IdP policy</p><h1>Sign-in blocked by identity provider policy</h1><p>${escapeHtml(message)}</p><p>error=access_denied</p></main></body></html>`,
  };
}

function matchesBlockedUser(subject: MockIdpSubject, blockedUser: string | null): boolean {
  if (!blockedUser) {
    return false;
  }
  const blocked = blockedUser.trim().toLowerCase();
  return subject.email.toLowerCase() === blocked || subject.sub.toLowerCase() === blocked;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

interface HtmlDocument {
  title: string;
  heading: string;
  paragraphs: string[];
}

function sendHtml(response: ServerResponse, status: number, document: HtmlDocument): void {
  // Escape at the write boundary so request-derived fields cannot reach the
  // HTML response as markup.
  const title = escapeHtml(document.title);
  const heading = escapeHtml(document.heading);
  const paragraphs = document.paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join("");
  const body = `<!doctype html><html><head><title>${title}</title></head><body><main style="font-family: sans-serif; max-width: 720px; margin: 48px auto;"><h1>${heading}</h1>${paragraphs}</main></body></html>`;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendRedirect(response: ServerResponse, location: string): void {
  response.writeHead(302, {
    location,
    "cache-control": "no-store",
  });
  response.end();
}

function method(request: IncomingMessage): string {
  return (request.method ?? "GET").toUpperCase();
}

function requestUrl(request: IncomingMessage, issuer: string): URL {
  return new URL(request.url ?? "/", issuer);
}

function headerValue(request: IncomingMessage, name: string): string {
  const raw = request.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0] ?? "";
  }
  return typeof raw === "string" ? raw : "";
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else {
      chunks.push(Buffer.from(String(chunk)));
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function formBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await requestBody(request));
}

function basicClientCredentials(authorization: string): { clientId: string; clientSecret: string } | null {
  if (!authorization.startsWith("Basic ")) {
    return null;
  }
  const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return null;
  }
  return {
    clientId: decodeURIComponent(decoded.slice(0, separator)),
    clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
  };
}

function clientAuthenticated(params: URLSearchParams, authorization: string, config: NormalizedMockIdpConfig): boolean {
  const basic = basicClientCredentials(authorization);
  const clientId = basic?.clientId ?? params.get("client_id") ?? "";
  const clientSecret = basic?.clientSecret ?? params.get("client_secret") ?? "";
  return safeEqual(clientId, config.clientId) && safeEqual(clientSecret, config.clientSecret);
}

function oidcRegistration(config: NormalizedMockIdpConfig, overrides: Partial<MockOidcRegistration> = {}): MockOidcRegistration {
  const issuer = overrides.issuer ?? config.issuer;
  return {
    kind: "oidc",
    issuer,
    domain: overrides.domain ?? config.domain,
    clientId: overrides.clientId ?? config.clientId,
    clientSecret: overrides.clientSecret ?? config.clientSecret,
    scopes: overrides.scopes ?? ["openid", "email", "profile"],
    skipDiscovery: overrides.skipDiscovery ?? false,
    authorizationEndpoint: overrides.authorizationEndpoint ?? `${issuer}/authorize`,
    tokenEndpoint: overrides.tokenEndpoint ?? `${issuer}/token`,
    jwksEndpoint: overrides.jwksEndpoint ?? `${issuer}/jwks`,
    userInfoEndpoint: overrides.userInfoEndpoint ?? `${issuer}/userinfo`,
    tokenEndpointAuthentication: "client_secret_post",
  };
}

function discovery(config: NormalizedMockIdpConfig): Record<string, unknown> {
  return {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/authorize`,
    token_endpoint: `${config.issuer}/token`,
    jwks_uri: `${config.issuer}/jwks`,
    userinfo_endpoint: `${config.issuer}/userinfo`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    scopes_supported: ["openid", "email", "profile"],
    claims_supported: ["sub", "email", "email_verified", "name", "preferred_username", "groups", "roles", "department"],
  };
}

function samlMetadata(config: NormalizedMockIdpConfig, certificate: string): string {
  const certBody = certificate
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  const entityId = escapeHtml(`${config.issuer}/saml/metadata`);
  const ssoUrl = escapeHtml(`${config.issuer}/saml/sso`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor entityID="${entityId}" xmlns="urn:oasis:names:tc:SAML:2.0:metadata">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${certBody}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${ssoUrl}"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;
}

function samlPostBindingPage(config: NormalizedMockIdpConfig): HtmlDocument {
  return {
    title: "OpenWork Mock IdP SAML endpoint",
    heading: "SAML POST binding endpoint",
    paragraphs: [
      "OpenWork Mock IdP lab",
      "This fixture exposes SAML metadata and a POST binding endpoint, but the OpenWork eval lab drives OIDC because this checkout implements OIDC and SAML SSO and OIDC keeps the signed-token path dependency-free.",
      `Issuer: ${config.issuer}`,
    ],
  };
}

function authorize(state: MockIdpState, url: URL, response: ServerResponse): void {
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const clientId = url.searchParams.get("client_id") ?? "";
  if (!redirectUri || !safeEqual(clientId, state.config.clientId)) {
    sendJson(response, 400, { error: "invalid_request", error_description: "redirect_uri and a registered client_id are required." });
    return;
  }

  const loginHint = url.searchParams.get("login_hint") ?? undefined;
  const requestedSubject = loginHint ? { email: loginHint } : undefined;
  const subject = subjectWithKnobs(state.config, requestedSubject);
  if (matchesBlockedUser(subject, state.config.knobs.blockedUser)) {
    const blocked = buildBlockedUserResponse(subject);
    sendHtml(response, blocked.status, {
      title: "OpenWork Mock IdP policy block",
      heading: "Sign-in blocked by identity provider policy",
      paragraphs: ["OpenWork Mock IdP policy", blocked.message, "error=access_denied"],
    });
    return;
  }

  const code = randomBytes(18).toString("base64url");
  state.codes.set(code, {
    clientId,
    nonce: url.searchParams.get("nonce"),
    redirectUri,
    subject,
  });

  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  const relayState = url.searchParams.get("state");
  if (relayState) {
    callback.searchParams.set("state", relayState);
  }
  sendRedirect(response, callback.toString());
}

async function token(state: MockIdpState, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const params = await formBody(request);
  if (!clientAuthenticated(params, headerValue(request, "authorization"), state.config)) {
    sendJson(response, 401, { error: "invalid_client", error_description: "The mock IdP did not recognize the OIDC client credentials." });
    return;
  }
  if (params.get("grant_type") !== "authorization_code") {
    sendJson(response, 400, { error: "unsupported_grant_type" });
    return;
  }
  const code = params.get("code") ?? "";
  const record = state.codes.get(code) ?? null;
  if (!record) {
    sendJson(response, 400, { error: "invalid_grant", error_description: "The authorization code was not issued by this mock IdP." });
    return;
  }
  state.codes.delete(code);
  const claims = buildOidcClaims({
    issuer: state.config.issuer,
    clientId: record.clientId,
    subject: record.subject,
    nonce: record.nonce,
    knobs: state.config.knobs,
  });
  const accessToken = randomBytes(24).toString("base64url");
  state.accessTokens.set(accessToken, claims);
  sendJson(response, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 300,
    id_token: signOidcJwt({ keyId: state.keys.keyId, privateKeyPem: state.keys.privateKeyPem, claims }),
  });
}

function userinfo(state: MockIdpState, request: IncomingMessage, response: ServerResponse): void {
  const authorization = headerValue(request, "authorization");
  const tokenValue = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  const claims = state.accessTokens.get(tokenValue) ?? null;
  if (!claims) {
    sendJson(response, 401, { error: "invalid_token" });
    return;
  }
  sendJson(response, 200, claims);
}

async function handleRequest(state: MockIdpState, certificate: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = requestUrl(request, state.config.issuer);
  if (method(request) === "GET" && url.pathname === "/.well-known/openid-configuration") {
    sendJson(response, 200, discovery(state.config));
    return;
  }
  if (method(request) === "GET" && url.pathname === "/jwks") {
    sendJson(response, 200, { keys: [state.keys.jwk] });
    return;
  }
  if (method(request) === "GET" && url.pathname === "/authorize") {
    authorize(state, url, response);
    return;
  }
  if (method(request) === "POST" && url.pathname === "/token") {
    await token(state, request, response);
    return;
  }
  if (method(request) === "GET" && url.pathname === "/userinfo") {
    userinfo(state, request, response);
    return;
  }
  if (method(request) === "GET" && url.pathname === "/saml/metadata") {
    response.writeHead(200, { "content-type": "application/samlmetadata+xml; charset=utf-8", "cache-control": "no-store" });
    response.end(samlMetadata(state.config, certificate));
    return;
  }
  if ((method(request) === "GET" || method(request) === "POST") && url.pathname === "/saml/sso") {
    sendHtml(response, 200, samlPostBindingPage(state.config));
    return;
  }
  sendJson(response, 404, { error: "not_found" });
}

function listen(server: Server, host: string, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (isAddressInfo(address)) {
        resolve(address);
        return;
      }
      reject(new Error("Mock IdP server did not expose a TCP port."));
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startMockIdpLab(input: MockIdpConfig = {}): Promise<StartedMockIdpLab> {
  const keys = createKeyMaterial();
  const certificate = certificateFromPublicKey(keys.publicKeyPem, input.knobs?.certTrailingNewline === true);
  const fixedIssuer = configuredMockIdpIssuer(input);
  const state: MockIdpState = {
    config: normalizeMockIdpConfig(input),
    keys,
    codes: new Map(),
    accessTokens: new Map(),
  };
  const server = createServer((request, response) => {
    void handleRequest(state, certificate, request, response).catch((error) => {
      sendJson(response, 500, { error: "mock_idp_error", message: error instanceof Error ? error.message : String(error) });
    });
  });
  const fixedPort = fixedIssuer?.port ? Number.parseInt(fixedIssuer.port, 10) : 0;
  const address = await listen(server, fixedIssuer?.hostname ?? "127.0.0.1", fixedPort);
  state.config = normalizeMockIdpConfig({
    ...input,
    issuer: fixedIssuer ? fixedIssuer.origin : `http://127.0.0.1:${address.port}`,
  });

  const stop = () => close(server);
  return {
    protocol: "oidc",
    config: state.config,
    issuer: state.config.issuer,
    authorizationEndpoint: `${state.config.issuer}/authorize`,
    tokenEndpoint: `${state.config.issuer}/token`,
    jwksEndpoint: `${state.config.issuer}/jwks`,
    userInfoEndpoint: `${state.config.issuer}/userinfo`,
    saml: {
      metadataUrl: `${state.config.issuer}/saml/metadata`,
      ssoPostUrl: `${state.config.issuer}/saml/sso`,
      certificate,
    },
    keyId: keys.keyId,
    certificate,
    publicKeyPem: keys.publicKeyPem,
    registration: (overrides = {}) => oidcRegistration(state.config, overrides),
    claimsFor: (subject) => buildOidcClaims({
      issuer: state.config.issuer,
      clientId: state.config.clientId,
      subject: subjectWithKnobs(state.config, subject),
      knobs: state.config.knobs,
    }),
    stop,
    [Symbol.asyncDispose]: stop,
  };
}
