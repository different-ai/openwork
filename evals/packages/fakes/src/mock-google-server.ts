import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { buildOidcClaims, signOidcJwt } from "./idp.ts";

interface MockGoogleServerOptions {
  accounts: string[];
  port: number;
  autoApprove: boolean;
  baseUrl?: string;
}

interface StartedMockGoogleServer {
  baseUrl: string;
  stop(): Promise<void>;
}

interface Account {
  sub: string;
  email: string;
  name: string;
}

interface RequestEntry {
  method: string;
  path: string;
  url: string;
  at: string;
}

interface PendingAuthorization {
  id: string;
  params: URLSearchParams;
}

interface AuthorizationCode {
  account: Account;
  clientId: string;
  codeChallenge: string | null;
  codeChallengeMethod: string;
  scope: string;
}

interface RefreshCredential {
  account: Account;
  clientId: string;
  scope: string;
}

interface RecordedDraft {
  to: string;
  body: string;
  threadId?: string;
  attachments?: RecordedAttachment[];
  tokenId: string;
  at: string;
}

interface RecordedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  dataBase64: string;
}

interface RecordedDriveUpload extends RecordedAttachment {
  tokenId: string;
  at: string;
}

interface SigningKeys {
  keyId: string;
  privateKeyPem: string;
}

interface MockGoogleState {
  accounts: Account[];
  autoApprove: boolean;
  baseUrl: string;
  requests: RequestEntry[];
  pending: Map<string, PendingAuthorization>;
  codes: Map<string, AuthorizationCode>;
  accessTokens: Map<string, Account>;
  refreshTokens: Map<string, RefreshCredential>;
  drafts: Map<string, RecordedDraft[]>;
  driveUploads: Map<string, RecordedDriveUpload[]>;
  keys: SigningKeys;
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

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

function accountName(email: string): string {
  const localPart = email.split("@")[0] ?? email;
  const words = localPart.split(/[._+-]+/).filter(Boolean);
  return words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ") || email;
}

function normalizeAccounts(values: string[]): Account[] {
  const emails = Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)));
  if (emails.length === 0) {
    throw new Error("startMockGoogle requires at least one account.");
  }
  return emails.map((email) => ({ sub: email, email, name: accountName(email) }));
}

function createSigningKeys(): SigningKeys {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    keyId: `mock-google-${randomUUID()}`,
    privateKeyPem: pair.privateKey,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body);
}

function sendRedirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { "cache-control": "no-store", location });
  response.end();
}

function method(request: IncomingMessage): string {
  return (request.method ?? "GET").toUpperCase();
}

function requestUrl(request: IncomingMessage, baseUrl: string): URL {
  return new URL(request.url ?? "/", baseUrl);
}

async function requestBuffer(request: IncomingMessage): Promise<Buffer> {
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
  return Buffer.concat(chunks);
}

async function requestBody(request: IncomingMessage): Promise<string> {
  return (await requestBuffer(request)).toString("utf8");
}

async function formBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await requestBody(request));
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const body = await requestBody(request);
  return body.trim() ? JSON.parse(body) : null;
}

function bearerToken(request: IncomingMessage): string | null {
  const raw = request.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
  if (!/^bearer /i.test(header)) return null;
  return header.slice("bearer ".length).trim() || null;
}

function tokenId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function accountForRequest(state: MockGoogleState, request: IncomingMessage): Account | null {
  const token = bearerToken(request);
  return token ? state.accessTokens.get(token) ?? null : null;
}

function recordRequest(state: MockGoogleState, request: IncomingMessage, url: URL): void {
  state.requests.push({
    method: method(request),
    path: url.pathname,
    url: `${url.pathname}${url.search}`,
    at: new Date().toISOString(),
  });
}

function callbackForCode(params: URLSearchParams, code: string): string | null {
  const redirectUri = params.get("redirect_uri");
  if (!redirectUri) return null;
  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  const relayState = params.get("state");
  if (relayState) callback.searchParams.set("state", relayState);
  return callback.toString();
}

function authorizeAccount(
  state: MockGoogleState,
  pending: PendingAuthorization,
  account: Account,
  response: ServerResponse,
): void {
  const code = `mock-google-code-${randomUUID()}`;
  const callback = callbackForCode(pending.params, code);
  if (!callback) {
    sendJson(response, 400, { error: "invalid_request", error_description: "redirect_uri is required" });
    return;
  }
  state.codes.set(code, {
    account,
    clientId: pending.params.get("client_id") ?? "mock-google-client",
    codeChallenge: pending.params.get("code_challenge"),
    codeChallengeMethod: pending.params.get("code_challenge_method") ?? "plain",
    scope: pending.params.get("scope") ?? "openid email profile",
  });
  state.pending.delete(pending.id);
  sendRedirect(response, callback);
}

function chooserPage(state: MockGoogleState, pending: PendingAuthorization): string {
  const accounts = state.accounts.map((account) => {
    const chooseUrl = new URL("/choose-account", state.baseUrl);
    chooseUrl.searchParams.set("request_id", pending.id);
    chooseUrl.searchParams.set("email", account.email);
    return `<li><a data-account-email="${escapeHtml(account.email)}" href="${escapeHtml(`${chooseUrl.pathname}${chooseUrl.search}`)}">${escapeHtml(account.name)} <span>${escapeHtml(account.email)}</span></a></li>`;
  }).join("");
  return `<!doctype html><html><head><title>Choose an account</title></head><body><main style="font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto;"><h1>Choose an account</h1><p>Continue to OpenWork</p><ul>${accounts}</ul></main></body></html>`;
}

function consentPage(pending: PendingAuthorization): string {
  const approveUrl = new URL("/approve", "http://mock.invalid");
  approveUrl.searchParams.set("request_id", pending.id);
  return `<!doctype html><html><head><title>Mock Google OAuth</title></head><body><main style="font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto;"><h1>Mock Google OAuth</h1><p>This fake Google provider is for OpenWork end-to-end tests.</p><form method="post" action="${escapeHtml(`${approveUrl.pathname}${approveUrl.search}`)}"><button>Approve OpenWork</button></form></main></body></html>`;
}

function authorize(state: MockGoogleState, url: URL, response: ServerResponse): void {
  if (!url.searchParams.get("redirect_uri")) {
    sendJson(response, 400, { error: "invalid_request", error_description: "redirect_uri is required" });
    return;
  }
  const pending: PendingAuthorization = {
    id: randomUUID(),
    params: new URLSearchParams(url.searchParams),
  };
  const selectAccount = (url.searchParams.get("prompt") ?? "").split(/\s+/).includes("select_account");
  if (selectAccount) {
    state.pending.set(pending.id, pending);
    sendHtml(response, 200, chooserPage(state, pending));
    return;
  }
  if (state.autoApprove) {
    authorizeAccount(state, pending, state.accounts[0], response);
    return;
  }
  state.pending.set(pending.id, pending);
  sendHtml(response, 200, consentPage(pending));
}

function chooseAccount(state: MockGoogleState, url: URL, response: ServerResponse): void {
  const pending = state.pending.get(url.searchParams.get("request_id") ?? "") ?? null;
  const account = state.accounts.find((candidate) => candidate.email === (url.searchParams.get("email") ?? "").toLowerCase()) ?? null;
  if (!pending || !account) {
    sendJson(response, 404, { error: "authorization_not_found" });
    return;
  }
  authorizeAccount(state, pending, account, response);
}

function approve(state: MockGoogleState, url: URL, response: ServerResponse): void {
  const pending = state.pending.get(url.searchParams.get("request_id") ?? "") ?? null;
  if (!pending) {
    sendJson(response, 404, { error: "authorization_not_found" });
    return;
  }
  authorizeAccount(state, pending, state.accounts[0], response);
}

function claimsFor(state: MockGoogleState, credential: RefreshCredential): Record<string, unknown> {
  return buildOidcClaims({
    issuer: state.baseUrl,
    clientId: credential.clientId,
    subject: credential.account,
  });
}

function issueCredential(state: MockGoogleState, credential: RefreshCredential): {
  accessToken: string;
  refreshToken: string;
  idToken: string;
} {
  const accessToken = `mock-google-access-${randomUUID()}`;
  const refreshToken = `mock-google-refresh-${randomUUID()}`;
  const claims = claimsFor(state, credential);
  state.accessTokens.set(accessToken, credential.account);
  state.refreshTokens.set(refreshToken, credential);
  return {
    accessToken,
    refreshToken,
    idToken: signOidcJwt({ keyId: state.keys.keyId, privateKeyPem: state.keys.privateKeyPem, claims }),
  };
}

async function token(state: MockGoogleState, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const params = await formBody(request);
  const grantType = params.get("grant_type") ?? "authorization_code";
  let credential: RefreshCredential;
  if (grantType === "authorization_code") {
    const codeValue = params.get("code") ?? "";
    const code = state.codes.get(codeValue) ?? null;
    if (!code) {
      sendJson(response, 400, { error: "invalid_grant" });
      return;
    }
    if (code.codeChallenge) {
      const verifier = params.get("code_verifier") ?? "";
      const expected = code.codeChallengeMethod === "S256"
        ? createHash("sha256").update(verifier).digest("base64url")
        : verifier;
      if (expected !== code.codeChallenge) {
        sendJson(response, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }
    state.codes.delete(codeValue);
    credential = { account: code.account, clientId: code.clientId, scope: code.scope };
  } else if (grantType === "refresh_token") {
    const refresh = state.refreshTokens.get(params.get("refresh_token") ?? "") ?? null;
    if (!refresh) {
      sendJson(response, 400, { error: "invalid_grant" });
      return;
    }
    credential = refresh;
  } else {
    sendJson(response, 400, { error: "unsupported_grant_type" });
    return;
  }

  const issued = issueCredential(state, credential);
  sendJson(response, 200, {
    access_token: issued.accessToken,
    refresh_token: issued.refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: credential.scope,
    id_token: issued.idToken,
  });
}

function userinfo(state: MockGoogleState, request: IncomingMessage, response: ServerResponse): void {
  const account = accountForRequest(state, request);
  if (!account) {
    sendJson(response, 401, { error: "invalid_token" });
    return;
  }
  sendJson(response, 200, { sub: account.sub, email: account.email, email_verified: true, name: account.name });
}

function decodedRawMessage(raw: string): string {
  try {
    return Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function splitMessage(message: string): { headers: string; body: string } {
  const separator = /\r?\n\r?\n/.exec(message);
  if (!separator || separator.index === undefined) return { headers: message, body: "" };
  return {
    headers: message.slice(0, separator.index),
    body: message.slice(separator.index + separator[0].length),
  };
}

function headerValue(headers: string, name: string): string {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const prefix = `${name.toLowerCase()}:`;
  const line = unfolded.split(/\r?\n/).find((candidate) => candidate.toLowerCase().startsWith(prefix));
  return line ? line.slice(line.indexOf(":") + 1).trim() : "";
}

function decodeBase64Body(body: string): string {
  try {
    return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return body;
  }
}

function mimeTextBody(headers: string, body: string): string | null {
  const contentType = headerValue(headers, "content-type");
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1] ?? null;
  if (boundary) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (!part.trim() || part.trim().startsWith("--")) continue;
      const split = splitMessage(part.replace(/^\r?\n/, ""));
      const decoded = mimeTextBody(split.headers, split.body);
      if (decoded !== null) return decoded;
    }
    return null;
  }
  if (contentType && !contentType.toLowerCase().startsWith("text/plain")) return null;
  return headerValue(headers, "content-transfer-encoding").toLowerCase() === "base64"
    ? decodeBase64Body(body)
    : body.trimEnd();
}

function draftBody(headers: string, body: string): string {
  return mimeTextBody(headers, body) ?? "";
}

function unquoteMimeParameter(value: string): string {
  return value.replace(/\\([\\"])/g, "$1");
}

function mimeParameter(value: string, name: string): string {
  const quoted = new RegExp(`${name}="((?:\\\\.|[^"\\\\])*)"`, "i").exec(value)?.[1];
  if (quoted !== undefined) return unquoteMimeParameter(quoted);
  return new RegExp(`${name}=([^;\\s]+)`, "i").exec(value)?.[1] ?? "";
}

function mimeAttachments(headers: string, body: string): RecordedAttachment[] {
  const contentType = headerValue(headers, "content-type");
  const boundary = mimeParameter(contentType, "boundary");
  if (boundary) {
    return body.split(`--${boundary}`).slice(1).flatMap((part) => {
      if (!part.trim() || part.trim().startsWith("--")) return [];
      const split = splitMessage(part.replace(/^\r?\n/, ""));
      return mimeAttachments(split.headers, split.body);
    });
  }

  const disposition = headerValue(headers, "content-disposition");
  if (!/^attachment(?:;|$)/i.test(disposition)) return [];
  const filename = mimeParameter(disposition, "filename") || mimeParameter(contentType, "name");
  const mimeType = contentType.split(";", 1)[0]?.trim() || "application/octet-stream";
  const content = headerValue(headers, "content-transfer-encoding").toLowerCase() === "base64"
    ? Buffer.from(body.replace(/\s+/g, ""), "base64")
    : Buffer.from(body.replace(/\r?\n$/, ""), "utf8");
  return [{ filename, mimeType, size: content.byteLength, dataBase64: content.toString("base64") }];
}

function draftInput(value: unknown): { raw: string; threadId?: string } {
  if (!isRecord(value) || !isRecord(value.message)) return { raw: "" };
  const raw = typeof value.message.raw === "string" ? value.message.raw : "";
  const threadId = typeof value.message.threadId === "string" ? value.message.threadId : undefined;
  return threadId ? { raw, threadId } : { raw };
}

async function createDraft(state: MockGoogleState, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const account = accountForRequest(state, request);
  const accessToken = bearerToken(request);
  if (!account || !accessToken) {
    sendJson(response, 401, { error: { code: 401, message: "Invalid Credentials" } });
    return;
  }
  const input = draftInput(await jsonBody(request));
  const message = decodedRawMessage(input.raw);
  const split = splitMessage(message);
  const draft: RecordedDraft = {
    to: headerValue(split.headers, "to"),
    body: draftBody(split.headers, split.body),
    tokenId: tokenId(accessToken),
    at: new Date().toISOString(),
  };
  if (input.threadId) draft.threadId = input.threadId;
  const attachments = mimeAttachments(split.headers, split.body);
  if (attachments.length > 0) draft.attachments = attachments;
  const mailbox = state.drafts.get(account.email) ?? [];
  mailbox.push(draft);
  state.drafts.set(account.email, mailbox);
  const threadId = input.threadId ?? `thread-${randomUUID()}`;
  sendJson(response, 200, {
    id: `draft-${randomUUID()}`,
    message: { id: `msg-${randomUUID()}`, threadId },
  });
}

function requestHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function parseDriveMultipart(body: Buffer, contentType: string): RecordedAttachment | null {
  const boundary = mimeParameter(contentType, "boundary");
  if (!boundary) return null;
  const partBoundary = Buffer.from(`\r\n--${boundary}\r\n`, "utf8");
  const firstHeaderEnd = body.indexOf(Buffer.from("\r\n\r\n", "utf8"));
  const secondPart = body.indexOf(partBoundary);
  if (firstHeaderEnd < 0 || secondPart < 0 || secondPart <= firstHeaderEnd) return null;

  const metadataText = body.subarray(firstHeaderEnd + 4, secondPart).toString("utf8");
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    return null;
  }
  const filename = isRecord(metadata) && typeof metadata.name === "string" ? metadata.name : "";
  if (!filename) return null;

  const secondHeaderStart = secondPart + partBoundary.byteLength;
  const secondHeaderEnd = body.indexOf(Buffer.from("\r\n\r\n", "utf8"), secondHeaderStart);
  const footer = Buffer.from(`\r\n--${boundary}--`, "utf8");
  const contentEnd = body.lastIndexOf(footer);
  if (secondHeaderEnd < 0 || contentEnd < 0 || contentEnd < secondHeaderEnd) return null;
  const headers = body.subarray(secondHeaderStart, secondHeaderEnd).toString("utf8");
  const mimeType = headerValue(headers, "content-type") || "application/octet-stream";
  const content = body.subarray(secondHeaderEnd + 4, contentEnd);
  return { filename, mimeType, size: content.byteLength, dataBase64: content.toString("base64") };
}

async function createDriveUpload(state: MockGoogleState, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const account = accountForRequest(state, request);
  const accessToken = bearerToken(request);
  if (!account || !accessToken) {
    sendJson(response, 401, { error: { code: 401, message: "Invalid Credentials" } });
    return;
  }
  const upload = parseDriveMultipart(await requestBuffer(request), requestHeader(request, "content-type"));
  if (!upload) {
    sendJson(response, 400, { error: { code: 400, message: "Invalid multipart upload" } });
    return;
  }
  const recorded: RecordedDriveUpload = {
    ...upload,
    tokenId: tokenId(accessToken),
    at: new Date().toISOString(),
  };
  const uploads = state.driveUploads.get(account.email) ?? [];
  uploads.push(recorded);
  state.driveUploads.set(account.email, uploads);
  const id = `drive-${randomUUID()}`;
  sendJson(response, 200, {
    id,
    name: upload.filename,
    mimeType: upload.mimeType,
    modifiedTime: recorded.at,
    webViewLink: `https://drive.google.test/file/d/${id}/view`,
    size: String(upload.size),
  });
}

function pendingAuthorizations(state: MockGoogleState): unknown {
  return {
    pending: Array.from(state.pending.values()).map((entry) => ({
      id: entry.id,
      accounts: state.accounts.map((account) => {
        const url = new URL("/choose-account", state.baseUrl);
        url.searchParams.set("request_id", entry.id);
        url.searchParams.set("email", account.email);
        return { email: account.email, chooseUrl: url.toString() };
      }),
    })),
  };
}

async function handleRequest(state: MockGoogleState, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = requestUrl(request, state.baseUrl);
  const requestMethod = method(request);
  recordRequest(state, request, url);
  if (requestMethod === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }
  if (requestMethod === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true, accounts: state.accounts.map((account) => account.email), autoApprove: state.autoApprove });
    return;
  }
  if (requestMethod === "GET" && url.pathname === "/requests") {
    sendJson(response, 200, { requests: state.requests });
    return;
  }
  if (requestMethod === "GET" && url.pathname === "/__mock-google/pending-authorizations") {
    sendJson(response, 200, pendingAuthorizations(state));
    return;
  }
  if (requestMethod === "GET" && url.pathname === "/__mock-google/drafts") {
    sendJson(response, 200, { drafts: state.drafts.get((url.searchParams.get("email") ?? "").toLowerCase()) ?? [] });
    return;
  }
  if (requestMethod === "GET" && url.pathname === "/__mock-google/drive-uploads") {
    sendJson(response, 200, { uploads: state.driveUploads.get((url.searchParams.get("email") ?? "").toLowerCase()) ?? [] });
    return;
  }
  if (requestMethod === "GET" && url.pathname === "/authorize") {
    authorize(state, url, response);
    return;
  }
  if (requestMethod === "GET" && url.pathname === "/choose-account") {
    chooseAccount(state, url, response);
    return;
  }
  if (requestMethod === "POST" && url.pathname === "/approve") {
    approve(state, url, response);
    return;
  }
  if (requestMethod === "POST" && url.pathname === "/token") {
    await token(state, request, response);
    return;
  }
  if (requestMethod === "GET" && url.pathname === "/userinfo") {
    userinfo(state, request, response);
    return;
  }
  if (requestMethod === "GET" && url.pathname === "/gmail/v1/users/me/profile") {
    const account = accountForRequest(state, request);
    if (!account) {
      sendJson(response, 401, { error: { code: 401, message: "Invalid Credentials" } });
      return;
    }
    sendJson(response, 200, { emailAddress: account.email, messagesTotal: 0, threadsTotal: 0, historyId: "1" });
    return;
  }
  if (requestMethod === "GET" && url.pathname === "/gmail/v1/users/me/messages") {
    if (!accountForRequest(state, request)) {
      sendJson(response, 401, { error: { code: 401, message: "Invalid Credentials" } });
      return;
    }
    sendJson(response, 200, { messages: [], resultSizeEstimate: 0 });
    return;
  }
  if (requestMethod === "POST" && url.pathname === "/gmail/v1/users/me/drafts") {
    await createDraft(state, request, response);
    return;
  }
  if (requestMethod === "POST" && url.pathname === "/upload/drive/v3/files") {
    await createDriveUpload(state, request, response);
    return;
  }
  sendJson(response, 404, { error: "not_found" });
}

function listen(server: Server, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (isAddressInfo(address)) {
        resolve(address);
        return;
      }
      reject(new Error("Mock Google server did not expose a TCP port."));
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
    server.closeIdleConnections();
  });
}

export async function startMockGoogleServer(options: MockGoogleServerOptions): Promise<StartedMockGoogleServer> {
  const state: MockGoogleState = {
    accounts: normalizeAccounts(options.accounts),
    autoApprove: options.autoApprove,
    baseUrl: options.baseUrl ?? "http://127.0.0.1",
    requests: [],
    pending: new Map(),
    codes: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
    drafts: new Map(),
    driveUploads: new Map(),
    keys: createSigningKeys(),
  };
  const server = createServer((request, response) => {
    void handleRequest(state, request, response).catch((error) => {
      sendJson(response, 500, { error: "mock_google_error", message: error instanceof Error ? error.message : String(error) });
    });
  });
  const address = await listen(server, options.port);
  state.baseUrl = options.baseUrl ?? `http://127.0.0.1:${address.port}`;
  let stopped = false;
  return {
    baseUrl: state.baseUrl,
    async stop() {
      if (stopped) return;
      stopped = true;
      await close(server);
    },
  };
}
