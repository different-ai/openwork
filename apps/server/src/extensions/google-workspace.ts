import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";

export const GOOGLE_WORKSPACE_EXTENSION_ID = "google-workspace";

const GOOGLE_WORKSPACE_DESKTOP_CLIENT_ID = "929071212606-pmkqimjhm2tnp68kbklnout0irllj99h.apps.googleusercontent.com";
const GOOGLE_WORKSPACE_CLIENT_ID_ENV = "OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID";
const GOOGLE_WORKSPACE_CLIENT_SECRET_ENV = "GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET";
const LEGACY_GOOGLE_WORKSPACE_CLIENT_SECRET_ENV = "OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET";
const GOOGLE_WORKSPACE_TOKEN_BROKER_URL_ENV = "OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL";
const GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT_ENV = "OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT";
const GOOGLE_WORKSPACE_AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const GOOGLE_WORKSPACE_API_TIMEOUT_MS = 30_000;
const GOOGLE_WORKSPACE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/drive.file",
];
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const DRIVE_FULL_SCOPE = "https://www.googleapis.com/auth/drive";
const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CHAT_SPACES_SCOPE = "https://www.googleapis.com/auth/chat.spaces.readonly";
const CHAT_MESSAGES_READ_SCOPE = "https://www.googleapis.com/auth/chat.messages.readonly";
const CHAT_MESSAGES_CREATE_SCOPE = "https://www.googleapis.com/auth/chat.messages.create";

export const GOOGLE_WORKSPACE_OPTIONAL_FEATURES = {
  gmailRead: [GMAIL_READONLY_SCOPE],
  driveFull: [DRIVE_FULL_SCOPE],
  calendarWrite: [CALENDAR_EVENTS_SCOPE],
  chat: [CHAT_SPACES_SCOPE, CHAT_MESSAGES_READ_SCOPE, CHAT_MESSAGES_CREATE_SCOPE],
} satisfies Record<string, string[]>;

export type GoogleWorkspaceOptionalFeature = keyof typeof GOOGLE_WORKSPACE_OPTIONAL_FEATURES;

function isGoogleWorkspaceOptionalFeature(value: string): value is GoogleWorkspaceOptionalFeature {
  return Object.hasOwn(GOOGLE_WORKSPACE_OPTIONAL_FEATURES, value);
}

export const GOOGLE_WORKSPACE_EXTENSION_ACTIONS = [
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "status",
    title: "Google Workspace status",
    description: "Check whether Google Workspace is connected and ready for OpenWork extension actions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "calendar_list_events",
    title: "List calendar events",
    description: "List events from the connected Google Calendar account for a requested time range.",
    inputSchema: {
      type: "object",
      properties: {
        timeMin: { type: "string", description: "Inclusive ISO datetime lower bound." },
        timeMax: { type: "string", description: "Exclusive ISO datetime upper bound." },
        maxResults: { type: "number", description: "Maximum events to return." },
      },
      required: ["timeMin", "timeMax"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "gmail_create_draft",
    title: "Create Gmail draft",
    description: "Create a Gmail draft for the connected account. This does not send email.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses." },
        cc: { type: "array", items: { type: "string" }, description: "Optional CC recipients." },
        bcc: { type: "array", items: { type: "string" }, description: "Optional BCC recipients." },
        subject: { type: "string", description: "Draft subject." },
        body: { type: "string", description: "Plain text draft body." },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "gmail_list_messages",
    title: "List Gmail messages",
    description: "List recent Gmail messages for the connected account. Requires Gmail read access (gmail.readonly scope).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional Gmail search query, e.g. 'is:unread' or 'from:someone@example.com'." },
        maxResults: { type: "number", description: "Maximum messages to return." },
      },
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "gmail_get_message",
    title: "Read Gmail message",
    description: "Read a Gmail message by id, including its plain text body. Requires Gmail read access (gmail.readonly scope).",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Gmail message id." },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "drive_search_files",
    title: "Search Drive files",
    description: "Search files available to OpenWork through the connected Google Drive scope. With full Drive access enabled, this searches the entire Drive.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text." },
        maxResults: { type: "number", description: "Maximum files to return." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "drive_read_file",
    title: "Read Drive file",
    description: "Read a Drive file available to OpenWork by file id.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file id." },
      },
      required: ["fileId"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "drive_update_file",
    title: "Update Drive file",
    description: "Replace the plain text content of a Drive file available to OpenWork by file id.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file id." },
        content: { type: "string", description: "New plain text content for the file." },
      },
      required: ["fileId", "content"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "calendar_create_event",
    title: "Create calendar event",
    description: "Create an event on the connected Google Calendar. Requires calendar editing access (calendar.events scope).",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title." },
        description: { type: "string", description: "Optional event description." },
        location: { type: "string", description: "Optional event location." },
        start: { type: "string", description: "Event start as ISO datetime." },
        end: { type: "string", description: "Event end as ISO datetime." },
        timeZone: { type: "string", description: "Optional IANA time zone, e.g. 'Europe/Paris'." },
        attendees: { type: "array", items: { type: "string" }, description: "Optional attendee email addresses." },
      },
      required: ["summary", "start", "end"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "chat_list_spaces",
    title: "List Google Chat spaces",
    description: "List Google Chat spaces for the connected account. Requires Google Chat access.",
    inputSchema: {
      type: "object",
      properties: {
        maxResults: { type: "number", description: "Maximum spaces to return." },
      },
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "chat_list_messages",
    title: "List Google Chat messages",
    description: "List recent messages in a Google Chat space. Requires Google Chat access.",
    inputSchema: {
      type: "object",
      properties: {
        spaceId: { type: "string", description: "Chat space id or resource name, e.g. 'spaces/AAAA1234'." },
        maxResults: { type: "number", description: "Maximum messages to return." },
      },
      required: ["spaceId"],
      additionalProperties: false,
    },
  },
  {
    extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
    action: "chat_send_message",
    title: "Send Google Chat message",
    description: "Send a text message to a Google Chat space. Requires Google Chat access.",
    inputSchema: {
      type: "object",
      properties: {
        spaceId: { type: "string", description: "Chat space id or resource name, e.g. 'spaces/AAAA1234'." },
        text: { type: "string", description: "Message text." },
      },
      required: ["spaceId", "text"],
      additionalProperties: false,
    },
  },
];

type GoogleWorkspaceFlow = {
  flowId: string;
  state: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  status: "pending" | "connected" | "failed" | "expired";
  authUrl: string;
  account: unknown;
  error: string | null;
  server: Server;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
}

function configDir(config: ServerConfig): string {
  return dirname(config.configPath?.trim() || resolve(homedir(), ".config", "openwork", "server.json"));
}

function googleWorkspaceCredentials() {
  const clientId = process.env[GOOGLE_WORKSPACE_CLIENT_ID_ENV]?.trim() || process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_ID?.trim() || GOOGLE_WORKSPACE_DESKTOP_CLIENT_ID;
  const clientSecret = process.env[GOOGLE_WORKSPACE_CLIENT_SECRET_ENV]?.trim() || process.env[LEGACY_GOOGLE_WORKSPACE_CLIENT_SECRET_ENV]?.trim() || "";
  const tokenBrokerUrl = process.env[GOOGLE_WORKSPACE_TOKEN_BROKER_URL_ENV]?.trim() || process.env.GOOGLE_WORKSPACE_TOKEN_BROKER_URL?.trim() || "";
  const missing: string[] = [];
  if (!clientId) missing.push(GOOGLE_WORKSPACE_CLIENT_ID_ENV);
  if (!clientSecret && !tokenBrokerUrl) missing.push(GOOGLE_WORKSPACE_CLIENT_SECRET_ENV);
  const customClient = clientId !== GOOGLE_WORKSPACE_DESKTOP_CLIENT_ID;
  return { clientId, clientSecret, tokenBrokerUrl, missing, customClient };
}

function googleWorkspaceDir(config: ServerConfig): string {
  return join(configDir(config), "extensions", GOOGLE_WORKSPACE_EXTENSION_ID);
}

function googleWorkspaceVaultPath(config: ServerConfig): string {
  return join(googleWorkspaceDir(config), "oauth.vault");
}

function googleWorkspacePlainTextVaultPath(config: ServerConfig): string {
  return join(googleWorkspaceDir(config), "oauth.dev-plaintext.json");
}

function googleWorkspaceVaultKeyPath(config: ServerConfig): string {
  return join(configDir(config), "vault-key");
}

function googleWorkspacePlainTextVaultEnabled() {
  return process.env.OPENWORK_DEV_MODE === "1" && process.env[GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT_ENV] === "1";
}

function googleWorkspaceVaultMode() {
  return googleWorkspacePlainTextVaultEnabled() ? "plaintext-dev" : "encrypted";
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlString(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createGoogleWorkspacePkce() {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function googleWorkspaceVaultKey(config: ServerConfig): Promise<Buffer> {
  const envKey = process.env.OPENWORK_ENCRYPTION_KEY?.trim();
  if (envKey) return createHash("sha256").update(envKey).digest();

  const keyPath = googleWorkspaceVaultKeyPath(config);
  try {
    const raw = await readFile(keyPath, "utf8");
    const key = Buffer.from(raw.trim(), "base64");
    if (key.byteLength === 32) return key;
  } catch (error) {
    if ((error as { code?: string })?.code !== "ENOENT") throw error;
  }

  const key = randomBytes(32);
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, `${key.toString("base64")}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(keyPath, 0o600).catch(() => undefined);
  return key;
}

async function readGoogleWorkspaceVault(config: ServerConfig): Promise<Record<string, unknown> | null> {
  const vaultMode = googleWorkspaceVaultMode();
  const target = vaultMode === "plaintext-dev" ? googleWorkspacePlainTextVaultPath(config) : googleWorkspaceVaultPath(config);
  try {
    const raw = await readFile(target, "utf8");
    if (!raw.trim()) return null;
    if (vaultMode === "plaintext-dev") {
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed) ? parsed : null;
    }
    const envelope = JSON.parse(raw) as unknown;
    if (!isRecord(envelope) || typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.data !== "string") return null;
    const key = await googleWorkspaceVaultKey(config);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(decrypted) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeGoogleWorkspaceVault(config: ServerConfig, value: Record<string, unknown>): Promise<void> {
  const vaultMode = googleWorkspaceVaultMode();
  const target = vaultMode === "plaintext-dev" ? googleWorkspacePlainTextVaultPath(config) : googleWorkspaceVaultPath(config);
  await mkdir(dirname(target), { recursive: true });
  if (vaultMode === "plaintext-dev") {
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(target, 0o600).catch(() => undefined);
    return;
  }
  const key = await googleWorkspaceVaultKey(config);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const envelope = { schemaVersion: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") };
  await writeFile(target, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);
}

async function removeGoogleWorkspaceVault(config: ServerConfig): Promise<void> {
  await Promise.all([
    rm(googleWorkspaceVaultPath(config), { force: true }),
    rm(googleWorkspacePlainTextVaultPath(config), { force: true }),
  ]);
}

function googleWorkspaceSafeAccount(account: unknown) {
  if (!isRecord(account)) return null;
  return {
    accountId: googleWorkspaceAccountId({ account }),
    email: typeof account.email === "string" ? account.email : null,
    name: typeof account.name === "string" ? account.name : null,
    picture: typeof account.picture === "string" ? account.picture : null,
    sub: typeof account.sub === "string" ? account.sub : null,
  };
}

function googleWorkspaceAccountId(record: unknown): string | null {
  if (!isRecord(record)) return null;
  const account = isRecord(record.account) ? record.account : null;
  const sub = typeof account?.sub === "string" && account.sub.trim() ? account.sub.trim() : null;
  const email = typeof account?.email === "string" && account.email.trim() ? account.email.trim().toLowerCase() : null;
  return sub ?? email;
}

function googleWorkspaceAccountRecords(record: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!record) return [];
  if (Array.isArray(record.accounts)) return record.accounts.filter(isRecord);
  return isRecord(record.token) ? [record] : [];
}

function googleWorkspacePrimaryRecord(record: Record<string, unknown> | null): Record<string, unknown> | null {
  const accounts = googleWorkspaceAccountRecords(record);
  if (accounts.length === 0) return null;
  const activeAccountId = typeof record?.activeAccountId === "string" ? record.activeAccountId : "";
  return accounts.find((account) => googleWorkspaceAccountId(account) === activeAccountId) ?? accounts[0] ?? null;
}

function googleWorkspacePublicAccounts(record: Record<string, unknown> | null) {
  return googleWorkspaceAccountRecords(record).map((entry) => ({
    ...googleWorkspaceSafeAccount(entry.account),
    accountId: googleWorkspaceAccountId(entry),
    scopes: Array.isArray(entry.scopes) ? entry.scopes.filter((item): item is string => typeof item === "string") : [],
    connectedAt: typeof entry.connectedAt === "string" ? entry.connectedAt : null,
  })).filter((entry) => entry.accountId !== null);
}

async function writeGoogleWorkspaceAccountsVault(config: ServerConfig, accounts: Record<string, unknown>[], activeAccountId: string | null): Promise<void> {
  if (accounts.length === 0) {
    await removeGoogleWorkspaceVault(config);
    return;
  }
  await writeGoogleWorkspaceVault(config, {
    version: 2,
    accounts,
    activeAccountId,
    updatedAt: new Date().toISOString(),
  });
}

async function upsertGoogleWorkspaceAccount(config: ServerConfig, accountRecord: Record<string, unknown>): Promise<void> {
  const accountId = googleWorkspaceAccountId(accountRecord);
  if (!accountId) throw new Error("Google account identifier is unavailable.");
  const current = await readGoogleWorkspaceVault(config);
  const accounts = googleWorkspaceAccountRecords(current);
  const nextAccounts = [accountRecord, ...accounts.filter((entry) => googleWorkspaceAccountId(entry) !== accountId)];
  await writeGoogleWorkspaceAccountsVault(config, nextAccounts, accountId);
}

function googleWorkspaceStatusPayload(record: Record<string, unknown> | null = null, extra: Record<string, unknown> = {}) {
  const credentials = googleWorkspaceCredentials();
  const primary = googleWorkspacePrimaryRecord(record);
  return {
    configured: credentials.missing.length === 0,
    missing: credentials.missing,
    customClient: credentials.customClient,
    vault: googleWorkspaceVaultMode(),
    connected: googleWorkspaceAccountRecords(record).length > 0,
    account: googleWorkspaceSafeAccount(primary?.account),
    accounts: googleWorkspacePublicAccounts(record),
    activeAccountId: googleWorkspaceAccountId(primary),
    scopes: Array.isArray(primary?.scopes) ? primary.scopes.filter((item): item is string => typeof item === "string") : [],
    connectedAt: typeof primary?.connectedAt === "string" ? primary.connectedAt : null,
    error: null,
    testStatus: null,
    smokeTest: null,
    ...extra,
  };
}

async function fetchGoogleJson(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_WORKSPACE_API_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") throw new Error("Google request timed out. Check your connection and try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text.trim()) {
    try { payload = JSON.parse(text) as unknown; } catch { payload = { raw: text }; }
  }
  if (!response.ok) {
    const details = isRecord(payload)
      ? isRecord(payload.error) && typeof payload.error.message === "string"
        ? payload.error.message
        : typeof payload.error_description === "string"
          ? payload.error_description
          : typeof payload.error === "string"
            ? payload.error
            : response.statusText
      : response.statusText;
    throw new Error(`Google request failed (${response.status}): ${details}`);
  }
  return payload;
}

async function fetchGoogleUserInfo(accessToken: string) {
  return fetchGoogleJson("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
}

async function fetchGoogleWorkspaceTokenBrokerJson(tokenBrokerUrl: string, body: Record<string, unknown>) {
  return fetchGoogleJson(tokenBrokerUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function exchangeGoogleWorkspaceCode(input: { code: string; redirectUri: string; verifier: string }) {
  const { clientId, clientSecret, tokenBrokerUrl, missing } = googleWorkspaceCredentials();
  if (missing.length > 0) throw new Error(`Missing Google OAuth configuration: ${missing.join(", ")}`);
  if (tokenBrokerUrl) {
    return fetchGoogleWorkspaceTokenBrokerJson(tokenBrokerUrl, {
      grantType: "authorization_code",
      provider: GOOGLE_WORKSPACE_EXTENSION_ID,
      clientId,
      code: input.code,
      codeVerifier: input.verifier,
      redirectUri: input.redirectUri,
    });
  }
  return fetchGoogleJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: input.code,
      code_verifier: input.verifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }),
  });
}

async function refreshGoogleWorkspaceVault(record: Record<string, unknown>) {
  const token = isRecord(record.token) ? record.token : null;
  const expiresAt = Number(token?.expiresAt ?? 0);
  const accessToken = typeof token?.accessToken === "string" ? token.accessToken : "";
  const refreshToken = typeof token?.refreshToken === "string" ? token.refreshToken : "";
  if (accessToken && expiresAt > Date.now() + 60_000) return record;
  if (!refreshToken) throw new Error("Google Workspace refresh token is missing. Reconnect Google Workspace.");
  const { clientId, clientSecret, tokenBrokerUrl, missing } = googleWorkspaceCredentials();
  if (missing.length > 0) throw new Error(`Missing Google OAuth configuration: ${missing.join(", ")}`);
  const refreshed = tokenBrokerUrl
    ? await fetchGoogleWorkspaceTokenBrokerJson(tokenBrokerUrl, { grantType: "refresh_token", provider: GOOGLE_WORKSPACE_EXTENSION_ID, clientId, refreshToken })
    : await fetchGoogleJson("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }),
    });
  if (!isRecord(refreshed) || typeof refreshed.access_token !== "string") throw new Error("Google OAuth refresh did not return an access token.");
  const next = {
    ...record,
    scopes: typeof refreshed.scope === "string" ? refreshed.scope.split(/\s+/).filter(Boolean) : record.scopes,
    token: {
      accessToken: refreshed.access_token,
      refreshToken: typeof refreshed.refresh_token === "string" ? refreshed.refresh_token : refreshToken,
      expiresAt: Date.now() + Number(refreshed.expires_in ?? 3600) * 1000,
    },
    updatedAt: new Date().toISOString(),
  };
  return next;
}

async function googleWorkspaceAccessToken(config: ServerConfig): Promise<{ record: Record<string, unknown>; accessToken: string }> {
  const vault = await readGoogleWorkspaceVault(config);
  const record = googleWorkspacePrimaryRecord(vault);
  if (!record) throw new ApiError(400, "google_workspace_not_connected", "Connect Google Workspace in OpenWork Settings to use this tool.");
  const refreshed = await refreshGoogleWorkspaceVault(record);
  const refreshedAccountId = googleWorkspaceAccountId(refreshed);
  if (refreshedAccountId) {
    const nextAccounts = googleWorkspaceAccountRecords(vault).map((entry) => googleWorkspaceAccountId(entry) === refreshedAccountId ? refreshed : entry);
    await writeGoogleWorkspaceAccountsVault(config, nextAccounts, refreshedAccountId);
  }
  const token = isRecord(refreshed.token) ? refreshed.token : null;
  const accessToken = typeof token?.accessToken === "string" ? token.accessToken : "";
  if (!accessToken) throw new Error("Google Workspace access token is unavailable. Reconnect Google Workspace.");
  return { record: refreshed, accessToken };
}

function multipartRelatedBody(metadata: Record<string, unknown>, content: string, boundary: string): string {
  return [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function stringArrayField(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function gmailRawMessage(input: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string }): string {
  return [
    `To: ${input.to.join(", ")}`,
    input.cc?.length ? `Cc: ${input.cc.join(", ")}` : null,
    input.bcc?.length ? `Bcc: ${input.bcc.join(", ")}` : null,
    `Subject: ${input.subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    input.body,
  ].filter((line): line is string => typeof line === "string").join("\r\n");
}

function requireScope(record: Record<string, unknown>, scope: string, code: string, message: string) {
  const scopes = Array.isArray(record.scopes) ? record.scopes : [];
  if (!scopes.includes(scope)) throw new ApiError(403, code, message);
}

function requireGmailReadScope(record: Record<string, unknown>) {
  requireScope(record, GMAIL_READONLY_SCOPE, "google_gmail_read_not_granted", "Gmail read access is not granted for this account. Reconnect Google Workspace with Gmail read access enabled.");
}

function requireCalendarWriteScope(record: Record<string, unknown>) {
  requireScope(record, CALENDAR_EVENTS_SCOPE, "google_calendar_write_not_granted", "Calendar editing access is not granted for this account. Reconnect Google Workspace with calendar editing enabled.");
}

function requireChatScope(record: Record<string, unknown>, scope: string) {
  requireScope(record, scope, "google_chat_not_granted", "Google Chat access is not granted for this account. Reconnect Google Workspace with Google Chat enabled.");
}

function gmailHeader(payload: unknown, name: string): string {
  if (!isRecord(payload) || !Array.isArray(payload.headers)) return "";
  const header = payload.headers.filter(isRecord).find((entry) => typeof entry.name === "string" && entry.name.toLowerCase() === name.toLowerCase());
  return header && typeof header.value === "string" ? header.value : "";
}

function gmailMessageSummary(message: unknown) {
  if (!isRecord(message)) return null;
  return {
    id: typeof message.id === "string" ? message.id : null,
    threadId: typeof message.threadId === "string" ? message.threadId : null,
    snippet: typeof message.snippet === "string" ? message.snippet : null,
    labelIds: Array.isArray(message.labelIds) ? message.labelIds.filter((item): item is string => typeof item === "string") : [],
    subject: gmailHeader(message.payload, "Subject"),
    from: gmailHeader(message.payload, "From"),
    to: gmailHeader(message.payload, "To"),
    date: gmailHeader(message.payload, "Date"),
  };
}

function decodeGmailBody(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function gmailMessageText(payload: unknown, mimePrefix = "text/plain"): string {
  if (!isRecord(payload)) return "";
  const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "";
  const data = isRecord(payload.body) && typeof payload.body.data === "string" ? payload.body.data : "";
  if (mimeType.startsWith(mimePrefix) && data) return decodeGmailBody(data);
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  for (const part of parts) {
    const text = gmailMessageText(part, mimePrefix);
    if (text) return text;
  }
  return "";
}

async function googleWorkspaceListMessages(config: ServerConfig, args: Record<string, unknown>) {
  const query = readStringField(args, "query");
  const maxResults = Math.min(Math.max(Number(args.maxResults ?? 10), 1), 50);
  const { record, accessToken } = await googleWorkspaceAccessToken(config);
  requireGmailReadScope(record);
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  if (query) url.searchParams.set("q", query);
  url.searchParams.set("maxResults", String(maxResults));
  const list = await fetchGoogleJson(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  const ids = isRecord(list) && Array.isArray(list.messages)
    ? list.messages.filter(isRecord).map((entry) => typeof entry.id === "string" ? entry.id : "").filter(Boolean)
    : [];
  const messages = await Promise.all(ids.map(async (id) => {
    const message = await fetchGoogleJson(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    return gmailMessageSummary(message);
  }));
  return { messages, resultSizeEstimate: isRecord(list) && typeof list.resultSizeEstimate === "number" ? list.resultSizeEstimate : null };
}

async function googleWorkspaceGetMessage(config: ServerConfig, args: Record<string, unknown>) {
  const messageId = readStringField(args, "messageId");
  if (!messageId) throw new ApiError(400, "invalid_payload", "messageId is required");
  const { record, accessToken } = await googleWorkspaceAccessToken(config);
  requireGmailReadScope(record);
  const message = await fetchGoogleJson(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const payload = isRecord(message) ? message.payload : null;
  const body = gmailMessageText(payload) || gmailMessageText(payload, "text/html");
  return { ...gmailMessageSummary(message), body };
}

async function googleWorkspaceListEvents(config: ServerConfig, args: Record<string, unknown>) {
  const timeMin = readStringField(args, "timeMin");
  const timeMax = readStringField(args, "timeMax");
  if (!timeMin || !timeMax) throw new ApiError(400, "invalid_payload", "timeMin and timeMax are required");
  const maxResults = Math.min(Math.max(Number(args.maxResults ?? 10), 1), 50);
  const { accessToken } = await googleWorkspaceAccessToken(config);
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(maxResults));
  return fetchGoogleJson(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
}

async function googleWorkspaceCreateDraft(config: ServerConfig, args: Record<string, unknown>) {
  const to = stringArrayField(args.to);
  const cc = stringArrayField(args.cc);
  const bcc = stringArrayField(args.bcc);
  const subject = readStringField(args, "subject");
  const body = typeof args.body === "string" ? args.body : "";
  if (!to.length || !subject || !body.trim()) throw new ApiError(400, "invalid_payload", "to, subject, and body are required");
  const { accessToken } = await googleWorkspaceAccessToken(config);
  return fetchGoogleJson("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw: base64UrlString(gmailRawMessage({ to, cc, bcc, subject, body })) } }),
  });
}

async function googleWorkspaceSearchFiles(config: ServerConfig, args: Record<string, unknown>) {
  const query = readStringField(args, "query");
  if (!query) throw new ApiError(400, "invalid_payload", "query is required");
  const maxResults = Math.min(Math.max(Number(args.maxResults ?? 10), 1), 50);
  const { accessToken } = await googleWorkspaceAccessToken(config);
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`);
  url.searchParams.set("pageSize", String(maxResults));
  url.searchParams.set("fields", "files(id,name,mimeType,webViewLink,modifiedTime,size)");
  return fetchGoogleJson(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
}

async function googleWorkspaceReadFile(config: ServerConfig, args: Record<string, unknown>) {
  const fileId = readStringField(args, "fileId");
  if (!fileId) throw new ApiError(400, "invalid_payload", "fileId is required");
  const { accessToken } = await googleWorkspaceAccessToken(config);
  const metadata = await fetchGoogleJson(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,webViewLink`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const mimeType = isRecord(metadata) && typeof metadata.mimeType === "string" ? metadata.mimeType : "";
  const exportMime = mimeType === "application/vnd.google-apps.document" ? "text/plain" : "";
  const url = exportMime
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const content = await response.text();
  if (!response.ok) throw new Error(`Google Drive read failed (${response.status}): ${content}`);
  return { metadata, content };
}

async function googleWorkspaceUpdateFile(config: ServerConfig, args: Record<string, unknown>) {
  const fileId = readStringField(args, "fileId");
  const content = typeof args.content === "string" ? args.content : "";
  if (!fileId || !content) throw new ApiError(400, "invalid_payload", "fileId and content are required");
  const { accessToken } = await googleWorkspaceAccessToken(config);
  return fetchGoogleJson(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,mimeType,webViewLink,modifiedTime`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "text/plain; charset=UTF-8" },
    body: content,
  });
}

async function googleWorkspaceCreateEvent(config: ServerConfig, args: Record<string, unknown>) {
  const summary = readStringField(args, "summary");
  const start = readStringField(args, "start");
  const end = readStringField(args, "end");
  if (!summary || !start || !end) throw new ApiError(400, "invalid_payload", "summary, start, and end are required");
  const description = readStringField(args, "description");
  const location = readStringField(args, "location");
  const timeZone = readStringField(args, "timeZone");
  const attendees = stringArrayField(args.attendees);
  const { record, accessToken } = await googleWorkspaceAccessToken(config);
  requireCalendarWriteScope(record);
  return fetchGoogleJson("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary,
      ...(description ? { description } : {}),
      ...(location ? { location } : {}),
      start: { dateTime: start, ...(timeZone ? { timeZone } : {}) },
      end: { dateTime: end, ...(timeZone ? { timeZone } : {}) },
      ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
    }),
  });
}

function chatSpaceName(args: Record<string, unknown>): string {
  const spaceId = readStringField(args, "spaceId");
  if (!spaceId) throw new ApiError(400, "invalid_payload", "spaceId is required");
  return spaceId.startsWith("spaces/") ? spaceId : `spaces/${spaceId}`;
}

async function googleWorkspaceListChatSpaces(config: ServerConfig, args: Record<string, unknown>) {
  const maxResults = Math.min(Math.max(Number(args.maxResults ?? 25), 1), 100);
  const { record, accessToken } = await googleWorkspaceAccessToken(config);
  requireChatScope(record, CHAT_SPACES_SCOPE);
  const url = new URL("https://chat.googleapis.com/v1/spaces");
  url.searchParams.set("pageSize", String(maxResults));
  return fetchGoogleJson(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
}

async function googleWorkspaceListChatMessages(config: ServerConfig, args: Record<string, unknown>) {
  const space = chatSpaceName(args);
  const maxResults = Math.min(Math.max(Number(args.maxResults ?? 25), 1), 100);
  const { record, accessToken } = await googleWorkspaceAccessToken(config);
  requireChatScope(record, CHAT_MESSAGES_READ_SCOPE);
  const url = new URL(`https://chat.googleapis.com/v1/${space}/messages`);
  url.searchParams.set("pageSize", String(maxResults));
  url.searchParams.set("orderBy", "createTime desc");
  return fetchGoogleJson(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
}

async function googleWorkspaceSendChatMessage(config: ServerConfig, args: Record<string, unknown>) {
  const space = chatSpaceName(args);
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) throw new ApiError(400, "invalid_payload", "text is required");
  const { record, accessToken } = await googleWorkspaceAccessToken(config);
  requireChatScope(record, CHAT_MESSAGES_CREATE_SCOPE);
  return fetchGoogleJson(`https://chat.googleapis.com/v1/${space}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export async function callGoogleWorkspaceExtensionAction(config: ServerConfig, action: string, args: Record<string, unknown>, context: Record<string, unknown>) {
  if (action === "status") {
    return {
      ok: true,
      extensionId: GOOGLE_WORKSPACE_EXTENSION_ID,
      action,
      result: await googleWorkspaceStatus(config),
      context,
    };
  }
  if (action === "calendar_list_events") return { ok: true, extensionId: GOOGLE_WORKSPACE_EXTENSION_ID, action, result: await googleWorkspaceListEvents(config, args), context };
  if (action === "gmail_create_draft") return { ok: true, extensionId: GOOGLE_WORKSPACE_EXTENSION_ID, action, result: await googleWorkspaceCreateDraft(config, args), context };
  if (action === "gmail_list_messages") return { ok: true, extensionId: GOOGLE_WORKSPACE_EXTENSION_ID, action, result: await googleWorkspaceListMessages(config, args), context };
  if (action === "gmail_get_message") return { ok: true, extensionId: GOOGLE_WORKSPACE_EXTENSION_ID, action, result: await googleWorkspaceGetMessage(config, args), context };
  if (action === "drive_search_files") return { ok: true, extensionId: GOOGLE_WORKSPACE_EXTENSION_ID, action, result: await googleWorkspaceSearchFiles(config, args), context };
  if (action === "drive_read_file") return { ok: true, extensionId: GOOGLE_WORKSPACE_EXTENSION_ID, action, result: await googleWorkspaceReadFile(config, args), context };
  if (action === "drive_update_file") return { ok: true, extensionId: GOOGLE_WORKSPACE_EXTENSION_ID, action, result: await googleWorkspaceUpdateFile(config, args), context };
  if (action === "calendar_create_event") return { ok: true, extensionId: GOOGLE_WORKSPACE_EXTENSION_ID, action, result: await googleWorkspaceCreateEvent(config, args), context };
  if (action === "chat_list_spaces") return { ok: true, extensionId: GOOGLE_WORKSPACE_EXTENSION_ID, action, result: await googleWorkspaceListChatSpaces(config, args), context };
  if (action === "chat_list_messages") return { ok: true, extensionId: GOOGLE_WORKSPACE_EXTENSION_ID, action, result: await googleWorkspaceListChatMessages(config, args), context };
  if (action === "chat_send_message") return { ok: true, extensionId: GOOGLE_WORKSPACE_EXTENSION_ID, action, result: await googleWorkspaceSendChatMessage(config, args), context };
  return null;
}

export async function googleWorkspaceStatus(config: ServerConfig) {
  try {
    const record = await readGoogleWorkspaceVault(config);
    return googleWorkspaceStatusPayload(record);
  } catch (error) {
    return googleWorkspaceStatusPayload(null, { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function googleWorkspaceTestConnection(config: ServerConfig) {
  const { record, accessToken } = await googleWorkspaceAccessToken(config);
  await fetchGoogleUserInfo(accessToken);
  await fetchGoogleJson("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1", { headers: { Authorization: `Bearer ${accessToken}` } });
  return googleWorkspaceStatusPayload(record, { testStatus: "Google profile and Calendar read access verified." });
}

export async function googleWorkspaceRunScopeSmokeTest(config: ServerConfig) {
  const { record, accessToken } = await googleWorkspaceAccessToken(config);
  const account = await fetchGoogleUserInfo(accessToken);
  const email = isRecord(account) && typeof account.email === "string" ? account.email : googleWorkspaceSafeAccount(record.account)?.email;
  if (!email) throw new Error("Google account email is unavailable.");
  await fetchGoogleJson("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1", { headers: { Authorization: `Bearer ${accessToken}` } });
  const createdAt = new Date().toISOString();
  const driveBoundary = `openwork_${randomBytes(8).toString("hex")}`;
  const driveFile = await fetchGoogleJson("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${driveBoundary}` },
    body: multipartRelatedBody({ name: "OpenWork Google Workspace smoke test.txt", mimeType: "text/plain" }, `OpenWork Google Workspace smoke test created at ${createdAt}.`, driveBoundary),
  });
  if (isRecord(driveFile) && typeof driveFile.id === "string") {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFile.id)}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`Google Drive smoke read failed (${response.status}): ${await response.text()}`);
  }
  const draft = await fetchGoogleJson("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw: base64UrlString(gmailRawMessage({ to: [email], subject: "OpenWork Google Workspace smoke test draft", body: `This draft was created by OpenWork to verify Gmail draft access at ${createdAt}.\nOpenWork does not send this email automatically.` })) } }),
  });
  return googleWorkspaceStatusPayload(record, {
    testStatus: "Calendar read, Drive file create/read, and Gmail draft creation verified.",
    smokeTest: {
      driveFileId: isRecord(driveFile) && typeof driveFile.id === "string" ? driveFile.id : null,
      driveFileName: isRecord(driveFile) && typeof driveFile.name === "string" ? driveFile.name : null,
      gmailDraftId: isRecord(draft) && typeof draft.id === "string" ? draft.id : null,
    },
  });
}

export async function googleWorkspaceSetActiveAccount(config: ServerConfig, accountId: string) {
  const vault = await readGoogleWorkspaceVault(config);
  const accounts = googleWorkspaceAccountRecords(vault);
  const account = accounts.find((entry) => googleWorkspaceAccountId(entry) === accountId);
  if (!account) throw new ApiError(404, "google_workspace_account_not_found", "Google Workspace account is not connected.");
  await writeGoogleWorkspaceAccountsVault(config, accounts, accountId);
  const nextVault = await readGoogleWorkspaceVault(config);
  return googleWorkspaceStatusPayload(nextVault, { testStatus: "Default Google Workspace account updated." });
}

export async function googleWorkspaceDisconnect(config: ServerConfig, accountId: string | null = null) {
  const vault = await readGoogleWorkspaceVault(config);
  const accounts = googleWorkspaceAccountRecords(vault);
  const selectedAccounts = accountId
    ? accounts.filter((entry) => googleWorkspaceAccountId(entry) === accountId)
    : accounts;
  let revokeError: Error | null = null;
  for (const record of selectedAccounts) {
    const token = isRecord(record.token) ? record.token : null;
    const revokeToken = typeof token?.refreshToken === "string" ? token.refreshToken : typeof token?.accessToken === "string" ? token.accessToken : "";
    if (!revokeToken) continue;
    try {
      await fetchGoogleJson("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: revokeToken }),
      });
    } catch (error) {
      revokeError = error instanceof Error ? error : new Error(String(error));
    }
  }
  const remainingAccounts = accountId
    ? accounts.filter((entry) => googleWorkspaceAccountId(entry) !== accountId)
    : [];
  const activeAccountId = remainingAccounts.length > 0 ? googleWorkspaceAccountId(remainingAccounts[0]) : null;
  await writeGoogleWorkspaceAccountsVault(config, remainingAccounts, activeAccountId);
  const nextVault = await readGoogleWorkspaceVault(config);
  return googleWorkspaceStatusPayload(nextVault, revokeError ? { error: `Local Google Workspace tokens were removed, but Google token revocation failed: ${revokeError.message}` } : { testStatus: "Google Workspace access revoked and local tokens removed." });
}

function escapeHtml(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function googleWorkspaceCallbackPage(status: number, title: string, body: string) {
  return new Response(`<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body style="font-family: system-ui, sans-serif; padding: 32px;"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><script>setTimeout(() => window.close(), 800);</script></body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", Connection: "close" },
  });
}

export function createGoogleWorkspaceConnectFlowManager(config: ServerConfig) {
  const flows = new Map<string, GoogleWorkspaceFlow>();

  const cleanup = (flowId: string) => {
    const flow = flows.get(flowId);
    if (!flow) return;
    flow.server.closeAllConnections?.();
    flow.server.close(() => undefined);
    flows.delete(flowId);
  };

  const start = async (options: { gmailRead?: boolean; features?: string[] } = {}) => {
    const credentials = googleWorkspaceCredentials();
    if (credentials.missing.length > 0) {
      throw new ApiError(400, "google_oauth_not_configured", `Missing Google OAuth configuration: ${credentials.missing.join(", ")}`);
    }
    const features = new Set((options.features ?? []).filter(isGoogleWorkspaceOptionalFeature));
    if (options.gmailRead) features.add("gmailRead");
    if (features.size > 0 && !credentials.customClient) {
      throw new ApiError(400, "google_extra_scopes_require_custom_client", "Extra Google permissions (Gmail read, full Drive, calendar editing, Google Chat) are only available when using your own Google OAuth client.");
    }
    const scopes = [...GOOGLE_WORKSPACE_SCOPES, ...[...features].flatMap((feature) => GOOGLE_WORKSPACE_OPTIONAL_FEATURES[feature])];
    const flowId = base64Url(randomBytes(18));
    const state = base64Url(randomBytes(24));
    const pkce = createGoogleWorkspacePkce();
    const expiresAt = Date.now() + GOOGLE_WORKSPACE_AUTH_TIMEOUT_MS;
    let callbackServer: Server | null = null;

    const port = await new Promise<number>((resolvePort, reject) => {
      callbackServer = createServer(async (request, response) => {
        const finish = async (page: Response) => {
          response.writeHead(page.status, Object.fromEntries(page.headers.entries()));
          response.end(await page.text());
        };
        try {
          const flow = flows.get(flowId);
          if (!flow) {
            await finish(googleWorkspaceCallbackPage(410, "Google Workspace connection expired", "Return to OpenWork and start connection again."));
            return;
          }
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          if (url.pathname !== "/" && url.pathname !== "/oauth/google-workspace/callback") {
            response.writeHead(404);
            response.end("Not found");
            return;
          }
          const error = url.searchParams.get("error");
          if (error) {
            flow.status = "failed";
            flow.error = `Google OAuth returned error: ${error}`;
            await finish(googleWorkspaceCallbackPage(400, "Google Workspace connection failed", error));
            return;
          }
          const returnedState = url.searchParams.get("state") ?? "";
          const code = url.searchParams.get("code") ?? "";
          if (returnedState !== flow.state || !code) {
            flow.status = "failed";
            flow.error = "Invalid Google OAuth callback.";
            await finish(googleWorkspaceCallbackPage(400, "Google Workspace connection failed", "Invalid OAuth callback."));
            return;
          }
          await finish(googleWorkspaceCallbackPage(200, "Google Workspace authorization received", "You can return to OpenWork while it finishes connecting."));
          try {
            const token = await exchangeGoogleWorkspaceCode({ code, redirectUri: flow.redirectUri, verifier: flow.verifier });
            if (!isRecord(token) || typeof token.access_token !== "string") throw new Error("Google OAuth response did not include an access token.");
            const account = await fetchGoogleUserInfo(token.access_token);
            const record = {
              version: 1,
              account,
              scopes: typeof token.scope === "string" ? token.scope.split(/\s+/).filter(Boolean) : scopes,
              token: {
                accessToken: token.access_token,
                refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : null,
                expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1000,
              },
              connectedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            await upsertGoogleWorkspaceAccount(config, record);
            flow.status = "connected";
            flow.account = account;
          } catch (exchangeError) {
            flow.status = "failed";
            flow.error = `Google authorized OpenWork, but token exchange failed: ${exchangeError instanceof Error ? exchangeError.message : String(exchangeError)}`;
          }
        } catch (callbackError) {
          const flow = flows.get(flowId);
          if (flow) {
            flow.status = "failed";
            flow.error = callbackError instanceof Error ? callbackError.message : String(callbackError);
          }
          if (!response.headersSent) {
            await finish(googleWorkspaceCallbackPage(500, "Google Workspace connection failed", callbackError instanceof Error ? callbackError.message : String(callbackError)));
          }
        }
      });
      callbackServer.once("error", reject);
      callbackServer.listen(0, "127.0.0.1", () => {
        const address = callbackServer?.address();
        const resolvedPort = typeof address === "object" && address ? address.port : null;
        if (!resolvedPort) reject(new Error("Could not start Google Workspace OAuth callback server."));
        else resolvePort(resolvedPort);
      });
    });
    if (!callbackServer) throw new Error("Could not start Google Workspace OAuth callback server.");
    const redirectUri = `http://127.0.0.1:${port}/`;
    const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.searchParams.set("client_id", credentials.clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", scopes.join(" "));
    authorizationUrl.searchParams.set("access_type", "offline");
    authorizationUrl.searchParams.set("prompt", "consent");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    flows.set(flowId, {
      flowId,
      state,
      verifier: pkce.verifier,
      redirectUri,
      expiresAt,
      status: "pending",
      authUrl: authorizationUrl.toString(),
      account: null,
      error: null,
      server: callbackServer,
    });
    setTimeout(() => {
      const flow = flows.get(flowId);
      if (!flow || flow.status !== "pending") return;
      flow.status = "expired";
      flow.error = "Google Workspace OAuth timed out.";
      flow.server.closeAllConnections?.();
      flow.server.close(() => undefined);
    }, GOOGLE_WORKSPACE_AUTH_TIMEOUT_MS + 1000).unref?.();
    return { flowId, authUrl: authorizationUrl.toString(), expiresAt };
  };

  const status = async (flowId: string) => {
    const flow = flows.get(flowId);
    if (!flow) throw new ApiError(404, "google_oauth_flow_not_found", "Google Workspace connection flow not found");
    if (flow.status === "pending" && flow.expiresAt <= Date.now()) {
      flow.status = "expired";
      flow.error = "Google Workspace OAuth timed out.";
    }
    const googleWorkspace = flow.status === "connected" ? await googleWorkspaceStatus(config) : null;
    const payload = {
      flowId: flow.flowId,
      status: flow.status,
      expiresAt: flow.expiresAt,
      error: flow.error,
      googleWorkspace,
    };
    if (flow.status !== "pending") setTimeout(() => cleanup(flow.flowId), 1000).unref?.();
    return payload;
  };

  return { start, status };
}
