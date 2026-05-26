import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile, rm, readdir, rename, stat, appendFile, mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { ApprovalRequest, Capabilities, ServerConfig, WorkspaceInfo, Actor, ReloadReason, ReloadTrigger, TokenScope } from "./types.js";
import { ApprovalService } from "./approvals.js";
import { addPlugin, listPlugins, normalizePluginSpec, removePlugin } from "./plugins.js";
import { sanitizePortableOpencodeConfig } from "./portable-opencode.js";
import { addMcp, listMcp, removeMcp, setMcpEnabled } from "./mcp.js";
import { deleteSkill, listSkills, upsertSkill } from "./skills.js";
import { installHubSkill, listHubSkills } from "./skill-hub.js";
import { deleteCommand, listCommands, repairCommands, upsertCommand } from "./commands.js";
import { ApiError, formatError } from "./errors.js";
import { readJsoncFile, updateJsoncPath, updateJsoncTopLevel, writeJsoncFile } from "./jsonc.js";
import { recordAudit, readAuditEntries, readLastAudit } from "./audit.js";
import { ReloadEventStore } from "./events.js";
import { computeReloadFingerprint } from "./reload-fingerprint.js";
import { startReloadWatchers } from "./reload-watcher.js";
import { opencodeConfigPath, openworkConfigPath, projectCommandsDir, projectSkillsDir } from "./workspace-files.js";
import { ensureDir, exists, hashToken, shortId } from "./utils.js";
import { workspaceIdForPath } from "./workspaces.js";
import { ensureWorkspaceFiles, readRawOpencodeConfig } from "./workspace-init.js";
import { sanitizeCommandName, validateMcpName } from "./validators.js";
import { TokenService } from "./tokens.js";
import { EnvService, EnvStoreReadError, InvalidEnvKeyError, isValidEnvKey } from "./env-file.js";
import { TOY_UI_CSS, TOY_UI_FAVICON_SVG, TOY_UI_HTML, TOY_UI_JS, cssResponse, htmlResponse, jsResponse, svgResponse } from "./toy-ui.js";
import { FileSessionStore } from "./file-sessions.js";
import {
  applyMaterializedBlueprintSessions,
  normalizeBlueprintSessionTemplates,
  readMaterializedBlueprintSessions,
  sanitizeOpenworkTemplateConfig,
} from "./blueprint-sessions.js";
import { inheritWorkspaceOpencodeConnection, resolveWorkspaceOpencodeConnection } from "./opencode-connection.js";
import { seedOpencodeSessionMessages } from "./opencode-db.js";
import { listPortableFiles } from "./portable-files.js";
import {
  buildWorkspaceImportPreview,
  normalizeWorkspaceImportPayload,
  publicWorkspaceImportPreview,
  summarizeWorkspaceImportApplied,
  summarizeWorkspaceImportPreview,
  type WorkspaceImportPlan,
  workspaceImportPreviewApprovalPaths,
} from "./workspace-import-preview.js";
import { buildSession, buildSessionList, buildSessionMessages, buildSessionSnapshot, buildSessionStatuses, buildSessionTodos } from "./session-read-model.js";
import {
  collectWorkspaceExportWarnings,
  stripSensitiveWorkspaceExportData,
  type WorkspaceExportSensitiveMode,
} from "./workspace-export-safety.js";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { serve, type ServeResult } from "./serve-node.js";
import pkg from "../package.json" with { type: "json" };
import constants from "../../../constants.json" with { type: "json" };

const SERVER_VERSION = pkg.version;
const OPENCODE_VERSION = constants.opencodeVersion.trim().replace(/^v/, "");

const FILE_SESSION_DEFAULT_TTL_MS = 15 * 60 * 1000;
const FILE_SESSION_MIN_TTL_MS = 30 * 1000;
const FILE_SESSION_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const FILE_SESSION_MAX_BATCH_ITEMS = 64;
const FILE_SESSION_MAX_FILE_BYTES = 5_000_000;
const FILE_SESSION_CATALOG_DEFAULT_LIMIT = 2000;
const FILE_SESSION_CATALOG_MAX_LIMIT = 10000;
const OPENWORK_VOICE_REALTIME_MODEL = "gpt-realtime-2";
const OPENWORK_VOICE_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const GOOGLE_WORKSPACE_DESKTOP_CLIENT_ID = "929071212606-pmkqimjhm2tnp68kbklnout0irllj99h.apps.googleusercontent.com";
const GOOGLE_WORKSPACE_CLIENT_ID_ENV = "OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID";
const GOOGLE_WORKSPACE_CLIENT_SECRET_ENV = "OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET";
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

const OPENWORK_VOICE_REALTIME_TOOLS = [
  {
    type: "function",
    name: "openwork_snapshot",
    description: "Read the current OpenWork UI control snapshot: route, status, narration, and visible action metadata.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "openwork_list_actions",
    description: "List semantic OpenWork UI actions. Call this before openwork_execute_action when you do not know the exact action id.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "openwork_execute_action",
    description: "Execute a semantic OpenWork UI action by id. Prefer this over screen coordinates or DOM guessing.",
    parameters: {
      type: "object",
      properties: {
        actionId: { type: "string", description: "The action id from openwork_list_actions, such as composer.set_text or composer.send." },
        args: { type: "object", description: "Optional JSON arguments for the action.", additionalProperties: true },
      },
      required: ["actionId"],
      additionalProperties: false,
    },
  },
];

const OPENWORK_EXPERIMENTAL_EXTENSION_ACTIONS = [
  {
    extensionId: "google-workspace",
    action: "status",
    title: "Google Workspace status",
    description: "Check whether Google Workspace is connected and ready for OpenWork extension actions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    extensionId: "google-workspace",
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
    extensionId: "google-workspace",
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
    extensionId: "google-workspace",
    action: "drive_search_files",
    title: "Search Drive files",
    description: "Search files available to OpenWork through the connected Google Drive scope.",
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
    extensionId: "google-workspace",
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
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listExperimentalExtensionActions(extensionId: string) {
  const filter = extensionId.trim();
  return filter
    ? OPENWORK_EXPERIMENTAL_EXTENSION_ACTIONS.filter((action) => action.extensionId === filter)
    : OPENWORK_EXPERIMENTAL_EXTENSION_ACTIONS;
}

async function callExperimentalExtensionAction(config: ServerConfig, input: unknown) {
  if (!isRecord(input)) {
    throw new ApiError(400, "invalid_payload", "Expected extension action call payload");
  }
  const extensionId = readStringField(input, "extensionId");
  const action = readStringField(input, "action");
  const args = isRecord(input.args) ? input.args : {};
  const context = isRecord(input.context) ? input.context : {};
  if (!extensionId || !action) {
    throw new ApiError(400, "invalid_payload", "extensionId and action are required");
  }
  const registered = OPENWORK_EXPERIMENTAL_EXTENSION_ACTIONS.find((item) => item.extensionId === extensionId && item.action === action);
  if (!registered) {
    throw new ApiError(404, "extension_action_not_found", "OpenWork extension action not found");
  }

  if (extensionId === "google-workspace" && action === "status") {
    const record = await readGoogleWorkspaceVault(config);
    return {
      ok: true,
      extensionId,
      action,
      result: googleWorkspaceStatusPayload(record),
      context,
    };
  }

  if (extensionId === "google-workspace" && action === "calendar_list_events") {
    return { ok: true, extensionId, action, result: await googleWorkspaceListEvents(config, args), context };
  }
  if (extensionId === "google-workspace" && action === "gmail_create_draft") {
    return { ok: true, extensionId, action, result: await googleWorkspaceCreateDraft(config, args), context };
  }
  if (extensionId === "google-workspace" && action === "drive_search_files") {
    return { ok: true, extensionId, action, result: await googleWorkspaceSearchFiles(config, args), context };
  }
  if (extensionId === "google-workspace" && action === "drive_read_file") {
    return { ok: true, extensionId, action, result: await googleWorkspaceReadFile(config, args), context };
  }

  throw new ApiError(501, "extension_action_not_implemented", `${registered.title} is registered but not implemented on openwork-server yet.`, { extensionId, action, args });
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
  const clientSecret = process.env[GOOGLE_WORKSPACE_CLIENT_SECRET_ENV]?.trim() || process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET?.trim() || "";
  const tokenBrokerUrl = process.env[GOOGLE_WORKSPACE_TOKEN_BROKER_URL_ENV]?.trim() || process.env.GOOGLE_WORKSPACE_TOKEN_BROKER_URL?.trim() || "";
  const missing: string[] = [];
  if (!clientId) missing.push(GOOGLE_WORKSPACE_CLIENT_ID_ENV);
  if (!clientSecret && !tokenBrokerUrl) missing.push(`${GOOGLE_WORKSPACE_CLIENT_SECRET_ENV} or ${GOOGLE_WORKSPACE_TOKEN_BROKER_URL_ENV}`);
  return { clientId, clientSecret, tokenBrokerUrl, missing };
}

function googleWorkspaceDir(config: ServerConfig): string {
  return join(configDir(config), "extensions", "google-workspace");
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
    email: typeof account.email === "string" ? account.email : null,
    name: typeof account.name === "string" ? account.name : null,
    picture: typeof account.picture === "string" ? account.picture : null,
    sub: typeof account.sub === "string" ? account.sub : null,
  };
}

function googleWorkspaceStatusPayload(record: Record<string, unknown> | null = null, extra: Record<string, unknown> = {}) {
  const credentials = googleWorkspaceCredentials();
  const token = isRecord(record?.token) ? record.token : null;
  return {
    configured: credentials.missing.length === 0,
    missing: credentials.missing,
    vault: googleWorkspaceVaultMode(),
    connected: Boolean(token?.refreshToken || token?.accessToken),
    account: googleWorkspaceSafeAccount(record?.account),
    scopes: Array.isArray(record?.scopes) ? record.scopes.filter((item): item is string => typeof item === "string") : [],
    connectedAt: typeof record?.connectedAt === "string" ? record.connectedAt : null,
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
      provider: "google-workspace",
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

async function refreshGoogleWorkspaceVault(config: ServerConfig, record: Record<string, unknown>) {
  const token = isRecord(record.token) ? record.token : null;
  const expiresAt = Number(token?.expiresAt ?? 0);
  const accessToken = typeof token?.accessToken === "string" ? token.accessToken : "";
  const refreshToken = typeof token?.refreshToken === "string" ? token.refreshToken : "";
  if (accessToken && expiresAt > Date.now() + 60_000) return record;
  if (!refreshToken) throw new Error("Google Workspace refresh token is missing. Reconnect Google Workspace.");
  const { clientId, clientSecret, tokenBrokerUrl, missing } = googleWorkspaceCredentials();
  if (missing.length > 0) throw new Error(`Missing Google OAuth configuration: ${missing.join(", ")}`);
  const refreshed = tokenBrokerUrl
    ? await fetchGoogleWorkspaceTokenBrokerJson(tokenBrokerUrl, { grantType: "refresh_token", provider: "google-workspace", clientId, refreshToken })
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
  await writeGoogleWorkspaceVault(config, next);
  return next;
}

async function googleWorkspaceAccessToken(config: ServerConfig): Promise<{ record: Record<string, unknown>; accessToken: string }> {
  const record = await readGoogleWorkspaceVault(config);
  if (!record) throw new ApiError(400, "google_workspace_not_connected", "Connect Google Workspace in OpenWork Settings to use this tool.");
  const refreshed = await refreshGoogleWorkspaceVault(config, record);
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

async function googleWorkspaceTestConnection(config: ServerConfig) {
  const { record, accessToken } = await googleWorkspaceAccessToken(config);
  await fetchGoogleUserInfo(accessToken);
  await fetchGoogleJson("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1", { headers: { Authorization: `Bearer ${accessToken}` } });
  return googleWorkspaceStatusPayload(record, { testStatus: "Google profile and Calendar read access verified." });
}

async function googleWorkspaceRunScopeSmokeTest(config: ServerConfig) {
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

function escapeHtml(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function googleWorkspaceCallbackPage(status: number, title: string, body: string) {
  return new Response(`<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body style="font-family: system-ui, sans-serif; padding: 32px;"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><script>setTimeout(() => window.close(), 800);</script></body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", Connection: "close" },
  });
}

async function resolveOpenAiRealtimeApiKey(env: EnvService): Promise<string> {
  const records = await env.list();
  const storedKey =
    records.find((entry) => entry.key === "OPENAI_REALTIME_API_KEY")?.value.trim() ||
    records.find((entry) => entry.key === "OPENAI_API_KEY")?.value.trim() ||
    "";
  if (storedKey) return storedKey;

  return process.env.OPENWORK_OPENAI_REALTIME_API_KEY?.trim() ||
    process.env.OPENAI_REALTIME_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
}

function openworkVoiceRealtimeInstructions() {
  return `# Role and Objective

You are OpenWork Voice Mode, a voice-first control layer inside OpenWork.
Help the user control OpenWork by using the semantic OpenWork UI tools.

# Tool Policy

- Prefer openwork_snapshot, openwork_list_actions, and openwork_execute_action over visual guessing.
- If the user asks to write or draft something, use composer.set_text.
- If the user asks to send or run the current prompt, use composer.send.
- For navigation, settings, session, transcript, and composer work, inspect the action list first if the action id is unknown.
- Do not claim an action completed until the tool succeeds.
- Ask for confirmation before destructive actions such as deleting a session.

# Voice Style

- Be concise, calm, and direct.
- If audio is unclear, ask the user to repeat it instead of guessing.
- Ignore background speech that is not addressed to OpenWork.
- Summarize tool results briefly and offer the next useful step.`;
}

function readOpenAiClientSecret(payload: unknown): { clientSecret: string; expiresAt: number | null } {
  if (!isRecord(payload)) return { clientSecret: "", expiresAt: null };
  const clientSecret = payload.client_secret;
  if (typeof clientSecret === "string") return { clientSecret, expiresAt: null };
  if (isRecord(clientSecret)) {
    const value = typeof clientSecret.value === "string" ? clientSecret.value : "";
    const expiresAt = typeof clientSecret.expires_at === "number" ? clientSecret.expires_at : null;
    return { clientSecret: value, expiresAt };
  }
  const value = typeof payload.value === "string" ? payload.value : "";
  return { clientSecret: value, expiresAt: null };
}

async function createOpenAiRealtimeVoiceSession(env: EnvService, input: unknown) {
  const apiKey = await resolveOpenAiRealtimeApiKey(env);
  if (!apiKey) {
    throw new ApiError(
      400,
      "openai_api_key_missing",
      "OpenAI API key missing. Save OPENAI_API_KEY in OpenWork Environment Variables or configure the Voice Mode extension.",
    );
  }

  const model = readStringField(input, "model") || OPENWORK_VOICE_REALTIME_MODEL;
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        output_modalities: ["audio"],
        audio: {
          input: {
            transcription: { model: OPENWORK_VOICE_TRANSCRIPTION_MODEL, language: "en" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.58,
              silence_duration_ms: 320,
              prefix_padding_ms: 300,
              create_response: true,
              interrupt_response: true,
            },
          },
        },
        instructions: openworkVoiceRealtimeInstructions(),
        tool_choice: "auto",
        tools: OPENWORK_VOICE_REALTIME_TOOLS,
      },
    }),
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorPayload = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    const message = typeof errorPayload?.message === "string" ? errorPayload.message : response.statusText;
    throw new ApiError(response.status, "openai_realtime_failed", message || "Failed to create OpenAI Realtime session");
  }

  const { clientSecret, expiresAt } = readOpenAiClientSecret(payload);
  if (!clientSecret) {
    throw new ApiError(502, "openai_realtime_invalid_response", "OpenAI did not return a usable Realtime client secret");
  }

  return {
    ok: true,
    clientSecret,
    expiresAt,
    model,
    transcriptionModel: OPENWORK_VOICE_TRANSCRIPTION_MODEL,
    tools: OPENWORK_VOICE_REALTIME_TOOLS.map((tool) => tool.name),
  };
}

const reloadBaselineRefreshers = new WeakMap<
  ServerConfig,
  (workspaceId: string, reasons?: ReloadReason[]) => Promise<void>
>();

type LogLevel = "info" | "warn" | "error";

type LogAttributes = Record<string, unknown>;

type ServerLogger = {
  log: (level: LogLevel, message: string, attributes?: LogAttributes) => void;
};

const LOG_LEVEL_NUMBERS: Record<LogLevel, number> = {
  info: 9,
  warn: 13,
  error: 17,
};

function toUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

export function createServerLogger(config: ServerConfig): ServerLogger {
  const runId = process.env.OPENWORK_RUN_ID ?? shortId();
  const host = hostname().trim();
  const resource: Record<string, string> = {
    "service.name": "openwork-server",
    "service.version": SERVER_VERSION,
    "service.instance.id": runId,
  };
  if (host) {
    resource["host.name"] = host;
  }
  const baseAttributes: LogAttributes = {
    "run.id": runId,
    "process.pid": process.pid,
  };

  const emit = (level: LogLevel, message: string, attributes?: LogAttributes) => {
    const merged = { ...baseAttributes, ...(attributes ?? {}) };
    if (config.logFormat === "json") {
      const record = {
        timeUnixNano: toUnixNano(),
        severityText: level.toUpperCase(),
        severityNumber: LOG_LEVEL_NUMBERS[level],
        body: message,
        attributes: merged,
        resource,
      };
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return;
    }
    process.stdout.write(`${message}\n`);
  };

  return { log: emit };
}

function logRequest(input: {
  logger: ServerLogger;
  request: Request;
  response: Response;
  durationMs: number;
  authMode: AuthMode;
  proxyService?: "opencode";
  proxyBaseUrl?: string;
  error?: string;
}) {
  const { logger, request, response, durationMs, authMode, proxyService, proxyBaseUrl, error } = input;
  const status = response.status;
  const level: LogLevel = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const proxyLabel = proxyBaseUrl ? ` (${proxyService ?? "proxy"})` : "";
  const message = `${method} ${url.pathname} ${status} ${durationMs}ms${proxyLabel}`;
  const attributes: LogAttributes = {
    method,
    path: url.pathname,
    status,
    durationMs,
    auth: authMode,
  };
  if (proxyBaseUrl) {
    attributes["proxy.base_url"] = proxyBaseUrl;
    if (proxyService) attributes["proxy.service"] = proxyService;
  }
  if (error) {
    attributes.error = error;
  }
  logger.log(level, message, attributes);
}

type AuthMode = "none" | "client" | "host" | "host-token";

function parseWorkspaceMount(pathname: string): { workspaceId: string; restPath: string } | null {
  if (!pathname.startsWith("/w/")) return null;
  const remainder = pathname.slice(3);
  if (!remainder) return null;
  const slash = remainder.indexOf("/");
  if (slash === -1) {
    return { workspaceId: decodeURIComponent(remainder), restPath: "/" };
  }
  const workspaceId = remainder.slice(0, slash);
  const restPath = remainder.slice(slash) || "/";
  if (!workspaceId.trim()) return null;
  return { workspaceId: decodeURIComponent(workspaceId), restPath };
}

function parseWorkspaceOpencodeMount(pathname: string): { workspaceId: string; restPath: string } | null {
  if (!pathname.startsWith("/workspace/")) return null;
  const remainder = pathname.slice("/workspace/".length);
  if (!remainder) return null;
  const slash = remainder.indexOf("/");
  if (slash === -1) return null;
  const workspaceId = remainder.slice(0, slash);
  const restPath = remainder.slice(slash) || "/";
  if (!workspaceId.trim()) return null;
  if (restPath !== "/opencode" && !restPath.startsWith("/opencode/")) return null;
  return { workspaceId: decodeURIComponent(workspaceId), restPath };
}

function normalizeOpencodeProxyPath(proxyPath: string): string {
  const raw = (proxyPath ?? "").trim() || "/";
  const withoutPrefix = raw.startsWith("/opencode") ? raw.slice("/opencode".length) : raw;
  const normalized = (withoutPrefix || "/").replace(/\/+$/, "");
  return normalized || "/";
}

function assertOpencodeProxyAllowed(actor: Actor, method: string, proxyPath: string) {
  const m = method.toUpperCase();
  const scope = actor.scope ?? "viewer";

  if (scope === "viewer" && m !== "GET" && m !== "HEAD") {
    throw new ApiError(403, "forbidden", "Viewer tokens are read-only");
  }

  // Prevent collaborators/viewers from self-approving OpenCode permission requests via the proxy.
  // OpenCode uses /permission/:requestId/reply (and historically also a session-scoped variant).
  if (scope !== "owner" && m !== "GET" && m !== "HEAD") {
    const normalized = normalizeOpencodeProxyPath(proxyPath);
    if (/\/permission\/[^/]+\/reply$/.test(normalized)) {
      throw new ApiError(403, "forbidden", "Only owner tokens can reply to permission requests");
    }
  }
}

function isSessionCommandProxyRequest(method: string, proxyPath: string) {
  return method === "POST" && /^\/session\/[^/]+\/command$/.test(normalizeOpencodeProxyPath(proxyPath));
}

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  auth: AuthMode;
  handler: (ctx: RequestContext) => Promise<Response>;
}

interface RequestContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  config: ServerConfig;
  approvals: ApprovalService;
  reloadEvents: ReloadEventStore;
  tokens: TokenService;
  actor?: Actor;
}

export async function startServer(config: ServerConfig): Promise<ServeResult> {
  const approvals = new ApprovalService(config.approval);
  const reloadEvents = new ReloadEventStore();
  const tokens = new TokenService(config);
  const env = new EnvService();
  const logger = createServerLogger(config);
  let watcherHandle = startReloadWatchers({ config, reloadEvents, logger });
  const refreshWorkspaceReloadBaseline = (workspaceId: string, reasons?: ReloadReason[]) =>
    watcherHandle.refreshWorkspace(workspaceId, reasons);
  reloadBaselineRefreshers.set(config, refreshWorkspaceReloadBaseline);
  const restartReloadWatchers = () => {
    watcherHandle.close();
    watcherHandle = startReloadWatchers({ config, reloadEvents, logger });
  };
  const routes = createRoutes(config, approvals, tokens, env, restartReloadWatchers);

  const serverOptions: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  } = {
    hostname: config.host,
    port: config.port,
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const startedAt = Date.now();
      let authMode: AuthMode = "none";
      let proxyService: "opencode" | undefined;
      let proxyBaseUrl: string | undefined;
      let errorMessage: string | undefined;

      const finalize = (response: Response) => {
        const wrapped = withCors(response, request, config);
        if (config.logRequests) {
            logRequest({
              logger,
              request,
              response: wrapped,
              durationMs: Date.now() - startedAt,
              authMode,
              proxyService,
              proxyBaseUrl,
              error: errorMessage,
            });
        }
        return wrapped;
      };

      const proxyWorkspaceOpencodeMount = async (mount: { workspaceId: string; restPath: string }) => {
        authMode = "client";
        try {
          const actor = await requireClient(request, config, tokens);
          assertOpencodeProxyAllowed(actor, request.method, mount.restPath);
          const workspace = await resolveWorkspace(config, mount.workspaceId);
          proxyService = "opencode";
          proxyBaseUrl = workspace.baseUrl?.trim() || undefined;
          const response = await proxyOpencodeRequest({ config, request, url, workspace, proxyPath: mount.restPath });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      };

      if (request.method === "OPTIONS") {
        return finalize(new Response(null, { status: 204 }));
      }

      const canonicalOpencodeMount = parseWorkspaceOpencodeMount(url.pathname);
      if (canonicalOpencodeMount) {
        return proxyWorkspaceOpencodeMount(canonicalOpencodeMount);
      }

      const mount = parseWorkspaceMount(url.pathname);
      if (mount && (mount.restPath === "/opencode" || mount.restPath.startsWith("/opencode/"))) {
        return proxyWorkspaceOpencodeMount(mount);
      }

      // Allow clients to use a mounted base URL (e.g. http://host:8787/w/<id>) while
      // still calling the existing /workspace/:id/* API surface.
      // Example: baseUrl + "/workspace/<id>/plugins" => "/w/<id>/workspace/<id>/plugins".
      // We strip the mount prefix and route-match on the rest path.
      //
      // Important: when using a mounted base URL, enforce that the nested /workspace/:id
      // matches the mount workspace id to preserve the "single-workspace" mental model.
      if (mount && mount.restPath.startsWith("/workspace/")) {
        const match = mount.restPath.match(/^\/workspace\/([^/]+)/);
        const nestedId = match?.[1] ? decodeURIComponent(match[1]) : null;
        if (nestedId && nestedId !== mount.workspaceId) {
          errorMessage = "not_found";
          return finalize(jsonResponse({ code: "not_found", message: "Not found" }, 404));
        }
        url.pathname = mount.restPath;
      }

      if (url.pathname === "/opencode" || url.pathname.startsWith("/opencode/")) {
        authMode = "client";
        proxyBaseUrl = config.workspaces[0]?.baseUrl?.trim() || undefined;
        try {
          const actor = await requireClient(request, config, tokens);
          assertOpencodeProxyAllowed(actor, request.method, url.pathname);
          proxyService = "opencode";
          const response = await proxyOpencodeRequest({ config, request, url, workspace: config.workspaces[0] });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      const route = matchRoute(routes, request.method, url.pathname);
      if (!route) {
        errorMessage = "not_found";
        return finalize(jsonResponse({ code: "not_found", message: "Not found" }, 404));
      }

      authMode = route.auth;
      try {
        const actor =
          route.auth === "host-token"
            ? requireHostToken(request, config)
            : route.auth === "host"
              ? await requireHost(request, config, tokens)
              : route.auth === "client"
                ? await requireClient(request, config, tokens)
                : undefined;
        const response = await route.handler({
          request,
          url,
          params: route.params,
          config,
          approvals,
          reloadEvents,
          tokens,
          actor,
        });
        return finalize(response);
      } catch (error) {
        if (!(error instanceof ApiError)) {
          console.error("[openwork-server] Unhandled error:", error);
        }
        const apiError = error instanceof ApiError
          ? error
          : new ApiError(500, "internal_error", "Unexpected server error");
        errorMessage = apiError.message;
        return finalize(jsonResponse(formatError(apiError), apiError.status));
      }
    },
  };

  const server = await serve({
    ...serverOptions,
    idleTimeout: 120,
  });

  return {
    ...server,
    stop: async () => {
      watcherHandle.close();
      reloadBaselineRefreshers.delete(config);
      await server.stop();
    },
  };
}

function matchRoute(routes: Route[], method: string, path: string) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = path.match(route.regex);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
    });
    return { ...route, params };
  }
  return null;
}

function addRoute(routes: Route[], method: string, path: string, auth: AuthMode, handler: Route["handler"]) {
  const keys: string[] = [];
  const regex = pathToRegex(path, keys);
  routes.push({ method, regex, keys, auth, handler });
}

function pathToRegex(path: string, keys: string[]): RegExp {
  const pattern = path.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return "([^/]+)";
  });
  return new RegExp(`^${pattern}$`);
}

function buildOpencodeProxyUrl(baseUrl: string, path: string, search: string) {
  const target = new URL(baseUrl);
  const trimmedPath = path.replace(/^\/opencode/, "");
  target.pathname = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  target.search = search;
  return target.toString();
}

function createOpencodeDirectoryFetch(directory: string): typeof fetch {
  return Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const headers = new Headers(init?.headers ?? request.headers);
      headers.set("x-opencode-directory", directory);
      return fetch(new Request(request, { headers }));
    },
    { preconnect: fetch.preconnect },
  );
}

type OpencodeClientResult<T, E> =
  | { data: T | undefined; error: undefined; response: Response }
  | { data: undefined; error: E; response: Response };

function createWorkspaceOpencodeClient(config: ServerConfig, workspace: WorkspaceInfo) {
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  const directory = resolveOpencodeDirectory(workspace);
  const directoryFetch = directory ? createOpencodeDirectoryFetch(directory) : undefined;

  return createOpencodeClient({
    baseUrl: connection.baseUrl?.trim(),
    ...(directory ? { directory } : {}),
    ...(directoryFetch ? { fetch: directoryFetch } : {}),
    ...(connection.authHeader ? { headers: { Authorization: connection.authHeader } } : {}),
  });
}

function unwrapOpencodeResult<T, E>(result: OpencodeClientResult<T, E>, path: string): NonNullable<T> {
  if (result.data != null) {
    return result.data;
  }
  if (result.error === undefined) {
    throw new ApiError(502, "opencode_empty_response", "OpenCode returned an empty response", { path });
  }
  throw new ApiError(502, "opencode_request_failed", "OpenCode request failed", {
    status: result.response.status,
    body: result.error,
    path,
  });
}

async function proxyOpencodeRequest(input: {
  config: ServerConfig;
  request: Request;
  url: URL;
  workspace?: WorkspaceInfo;
  proxyPath?: string;
}) {
  const workspace = input.workspace;
  const baseUrl = workspace ? resolveWorkspaceOpencodeConnection(input.config, workspace).baseUrl?.trim() ?? "" : "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const proxyPath = input.proxyPath ?? input.url.pathname;
  const targetUrl = buildOpencodeProxyUrl(baseUrl, proxyPath, input.url.search);
  const headers = new Headers(input.request.headers);
  headers.delete("authorization");
  headers.delete("x-openwork-host-token");
  headers.delete("x-openwork-client-id");
  headers.delete("host");
  headers.delete("origin");

  const directory = workspace ? resolveOpencodeDirectory(workspace) : null;
  if (directory && !headers.has("x-opencode-directory")) {
    headers.set("x-opencode-directory", directory);
  }

  const auth = workspace ? resolveWorkspaceOpencodeConnection(input.config, workspace).authHeader ?? null : null;
  if (auth) {
    headers.set("Authorization", auth);
  }

  const method = input.request.method.toUpperCase();
  // Buffer the request body so it can be forwarded reliably across Node.js
  // stream boundaries (Readable.toWeb streams from the HTTP adapter aren't
  // always accepted directly by Node's global fetch as a body).
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : await input.request.arrayBuffer().then((buf) => (buf.byteLength > 0 ? buf : undefined));
  if (isSessionCommandProxyRequest(method, proxyPath)) {
    void fetch(targetUrl, {
      method,
      headers,
      body,
    }).catch(() => {
      // Command failures are surfaced through the OpenCode event stream.
    });
    return jsonResponse({ ok: true, accepted: true });
  }
  const response = await fetch(targetUrl, {
    method,
    headers,
    body,
  });

  return sanitizeProxyResponse(response);
}

/**
 * Strip hop-by-hop and transport-level headers that Bun's native fetch keeps
 * in the upstream response even after it has already decoded the body for us.
 * Without this the browser sees `content-encoding: gzip` on a plain-text
 * payload and bails out with ERR_CONTENT_DECODING_FAILED, breaking any UI
 * code that reaches through /opencode/* (including session.create).
 */
function sanitizeProxyResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.delete("content-length");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCors(response: Response, request: Request, config: ServerConfig) {
  const origin = request.headers.get("origin");
  const allowedOrigins = config.corsOrigins;
  let allowOrigin: string | null = null;
  if (allowedOrigins.includes("*")) {
    allowOrigin = "*";
  } else if (origin && allowedOrigins.includes(origin)) {
    allowOrigin = origin;
  }

  if (!allowOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-OpenWork-Host-Token, X-OpenWork-Client-Id, X-OpenCode-Directory, X-Opencode-Directory, x-opencode-directory",
  );
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

async function requireClient(request: Request, config: ServerConfig, tokens: TokenService): Promise<Actor> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];
  if (!token) {
    throw new ApiError(401, "unauthorized", "Invalid bearer token");
  }
  const scope = await tokens.scopeForToken(token);
  if (!scope) {
    throw new ApiError(401, "unauthorized", "Invalid bearer token");
  }
  const clientId = request.headers.get("x-openwork-client-id") ?? undefined;
  return { type: "remote", clientId, tokenHash: hashToken(token), scope };
}

function requireHostToken(request: Request, config: ServerConfig): Actor {
  const hostToken = request.headers.get("x-openwork-host-token");
  if (hostToken && hostToken === config.hostToken) {
    return { type: "host", tokenHash: hashToken(hostToken), scope: "owner" };
  }
  throw new ApiError(401, "unauthorized", "Invalid host token");
}

async function requireHost(request: Request, config: ServerConfig, tokens: TokenService): Promise<Actor> {
  const hostToken = request.headers.get("x-openwork-host-token");
  if (hostToken && hostToken === config.hostToken) {
    return { type: "host", tokenHash: hashToken(hostToken), scope: "owner" };
  }

  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const bearer = match?.[1];
  if (!bearer) {
    throw new ApiError(401, "unauthorized", "Invalid host token");
  }
  const scope = await tokens.scopeForToken(bearer);
  if (scope !== "owner") {
    throw new ApiError(401, "unauthorized", "Invalid host token");
  }
  const clientId = request.headers.get("x-openwork-client-id") ?? undefined;
  return { type: "remote", clientId, tokenHash: hashToken(bearer), scope };
}

function buildCapabilities(config: ServerConfig): Capabilities {
  const writeEnabled = !config.readOnly;
  const schemaVersion = 1;
  const sandboxBackend = resolveSandboxBackend();
  const sandboxEnabled = resolveSandboxEnabled(sandboxBackend);
  const inboxEnabled = resolveInboxEnabled();
  const outboxEnabled = resolveOutboxEnabled();
  const maxBytes = resolveInboxMaxBytes();
  const toyUiEnabled = resolveToyUiEnabled();
  const browserProvider = resolveBrowserProvider();
  const opencodeConfigured = config.workspaces.some((workspace) => Boolean(workspace.baseUrl?.trim()));
  return {
    schemaVersion,
    serverVersion: SERVER_VERSION,
    opencodeVersion: OPENCODE_VERSION,
    skills: { read: true, write: writeEnabled, source: "openwork" },
    hub: {
      skills: {
        read: true,
        install: writeEnabled,
        repo: { owner: "different-ai", name: "openwork-hub", ref: "main" },
      },
    },
    plugins: { read: true, write: writeEnabled },
    mcp: { read: true, write: writeEnabled },
    commands: { read: true, write: writeEnabled },
    config: { read: true, write: writeEnabled },

    approvals: { mode: config.approval.mode, timeoutMs: config.approval.timeoutMs },
    sandbox: { enabled: sandboxEnabled, backend: sandboxBackend },
    ui: { toy: toyUiEnabled },
    tokens: { scoped: true, scopes: ["owner", "collaborator", "viewer"] },
    proxy: {
      opencode: opencodeConfigured,
    },
    toolProviders: {
      browser: browserProvider,
      files: {
        injection: writeEnabled && inboxEnabled,
        outbox: outboxEnabled,
        inboxPath: ".opencode/openwork/inbox/",
        outboxPath: ".opencode/openwork/outbox/",
        maxBytes,
      },
    },
  };
}

function resolveSandboxBackend(): Capabilities["sandbox"]["backend"] {
  const raw = (process.env.OPENWORK_SANDBOX_BACKEND ?? "").trim().toLowerCase();
  if (raw === "docker") return "docker";
  if (raw === "container") return "container";
  return "none";
}

function resolveSandboxEnabled(backend: Capabilities["sandbox"]["backend"]): boolean {
  const raw = (process.env.OPENWORK_SANDBOX_ENABLED ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return backend !== "none";
}

function resolveInboxEnabled(): boolean {
  const raw = (process.env.OPENWORK_INBOX_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveOutboxEnabled(): boolean {
  const raw = (process.env.OPENWORK_OUTBOX_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveInboxMaxBytes(): number {
  const raw = (process.env.OPENWORK_INBOX_MAX_BYTES ?? "").trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.trunc(parsed), 250_000_000);
  }
  return 50_000_000;
}

function resolveToyUiEnabled(): boolean {
  const raw = (process.env.OPENWORK_TOY_UI ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

// Dev-only log sink target. When OPENWORK_DEV_LOG_FILE is set to a path, the
// /dev/log endpoint accepts JSON payloads and appends them to that file so an
// operator can `tail -f` the file to see live browser activity. Returning null
// disables the endpoint entirely.
function resolveDevLogPath(): string | null {
  const raw = (process.env.OPENWORK_DEV_LOG_FILE ?? "").trim();
  return raw.length > 0 ? raw : null;
}

function resolveBrowserProvider(): Capabilities["toolProviders"]["browser"] {
  const raw = (process.env.OPENWORK_BROWSER_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "sandbox-headless") {
    return { enabled: true, placement: "in-sandbox", mode: "headless" };
  }
  if (raw === "host-interactive") {
    return { enabled: true, placement: "host-machine", mode: "interactive" };
  }
  if (raw === "client-interactive") {
    return { enabled: true, placement: "client-machine", mode: "interactive" };
  }
  return { enabled: false, placement: "external", mode: "none" };
}

function resolveInboxDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "openwork", "inbox");
}

function resolveOutboxDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "openwork", "outbox");
}

export function normalizeWorkspaceRelativePath(input: string, options: { allowSubdirs: boolean }): string {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new ApiError(400, "invalid_path", "Path is required");
  }
  if (raw.includes("\u0000")) {
    throw new ApiError(400, "invalid_path", "Path contains null byte");
  }

  // A lot of user-facing surfaces (artifacts, tool logs) reference files as
  // `workspace/<path>` or `/workspace/<path>`. The server API expects
  // workspace-relative paths, so normalize those common prefixes here.
  let normalized = raw.replace(/\\/g, "/");
  normalized = normalized.replace(/^\/+/, "");
  normalized = normalized.replace(/^\.\//, "");
  normalized = normalized.replace(/^workspaces\/[^/]+\//i, "");
  normalized = normalized.replace(/^workspace\/(?:ws_[^/]+|\d+|[0-9a-f-]{6,})\//i, "");
  normalized = normalized.replace(/^workspace\//, "");
  normalized = normalized.replace(/^\/+/, "");

  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) {
    throw new ApiError(400, "invalid_path", "Path is required");
  }
  if (!options.allowSubdirs && parts.length > 1) {
    throw new ApiError(400, "invalid_path", "Subdirectories are not allowed");
  }
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
    }
  }
  return parts.join("/");
}

export function isSupportedWorkspaceTextFilePath(relativePath: string): boolean {
  const lowered = relativePath.toLowerCase();
  return [
    ".md",
    ".mdx",
    ".markdown",
    ".csv",
    ".tsv",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".html",
    ".htm",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".css",
    ".scss",
    ".txt",
    ".log",
  ].some((ext) =>
    lowered.endsWith(ext),
  );
}

function resolveSafeChildPath(root: string, child: string): string {
  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, child);
  if (candidate === rootResolved) {
    throw new ApiError(400, "invalid_path", "Path must point to a file");
  }
  if (!candidate.startsWith(rootResolved + sep)) {
    throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
  }
  return candidate;
}

function encodeArtifactId(path: string): string {
  return Buffer.from(path, "utf8").toString("base64url");
}

function decodeArtifactId(id: string): string {
  const raw = (id ?? "").trim();
  if (!raw) {
    throw new ApiError(400, "invalid_artifact", "Artifact id is required");
  }
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    return normalizeWorkspaceRelativePath(decoded, { allowSubdirs: true });
  } catch {
    throw new ApiError(400, "invalid_artifact", "Artifact id is invalid");
  }
}

function contentTypeForPath(path: string): string {
  const lowered = path.toLowerCase();
  if (lowered.endsWith(".html") || lowered.endsWith(".htm")) return "text/html; charset=utf-8";
  if (lowered.endsWith(".svg")) return "image/svg+xml";
  if (lowered.endsWith(".png")) return "image/png";
  if (lowered.endsWith(".jpg") || lowered.endsWith(".jpeg")) return "image/jpeg";
  if (lowered.endsWith(".gif")) return "image/gif";
  if (lowered.endsWith(".webp")) return "image/webp";
  if (lowered.endsWith(".pdf")) return "application/pdf";
  if (lowered.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (lowered.endsWith(".tsv")) return "text/tab-separated-values; charset=utf-8";
  if (lowered.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lowered.endsWith(".xls")) return "application/vnd.ms-excel";
  if (lowered.endsWith(".ods")) return "application/vnd.oasis.opendocument.spreadsheet";
  if (isSupportedWorkspaceTextFilePath(path)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

type ArtifactTargetInput = {
  kind?: unknown;
  value?: unknown;
  name?: unknown;
  preview?: unknown;
  confidence?: unknown;
  reason?: unknown;
};

function artifactPreviewForPath(path: string): string {
  const lowered = path.toLowerCase();
  if (/\.(md|markdown|mdx)$/.test(lowered)) return "markdown";
  if (/\.(csv|tsv|xlsx|xls|ods)$/.test(lowered)) return "sheet";
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(lowered)) return "image";
  if (lowered.endsWith(".pdf")) return "pdf";
  if (/\.(html|htm)$/.test(lowered)) return "html";
  if (isSupportedWorkspaceTextFilePath(path)) return "text";
  return "external";
}

function normalizeUrlTarget(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function resolveWorkspaceArtifactTargets(workspaceRoot: string, input: unknown): Promise<Array<Record<string, unknown>>> {
  const targets = Array.isArray(input) ? input.slice(0, 80) : [];
  const results = new Map<string, Record<string, unknown>>();
  const workspaceResolved = resolve(workspaceRoot);

  for (const item of targets) {
    if (!item || typeof item !== "object") continue;
    const target = item as ArtifactTargetInput;
    const kind = target.kind === "url" ? "url" : "file";
    const rawValue = typeof target.value === "string" ? target.value.trim() : "";
    if (!rawValue) continue;
    const confidence = typeof target.confidence === "number" && Number.isFinite(target.confidence) ? target.confidence : 0;
    const reason = typeof target.reason === "string" ? target.reason : "server";

    if (kind === "url") {
      const url = normalizeUrlTarget(rawValue);
      if (!url) continue;
      const key = `url:${url}`;
      const next = {
        id: key,
        kind: "url",
        value: url,
        name: typeof target.name === "string" && target.name.trim() ? target.name.trim() : url,
        preview: "browser",
        confidence,
        reason,
        exists: true,
      };
      const previous = results.get(key);
      if (!previous || confidence >= Number(previous.confidence ?? 0)) results.set(key, next);
      continue;
    }

    let relativePath: string;
    try {
      if (isAbsolute(rawValue)) {
        const absolutePath = resolve(rawValue);
        const pathFromWorkspace = relative(workspaceResolved, absolutePath);
        if (!pathFromWorkspace || pathFromWorkspace === ".." || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace)) {
          continue;
        }
        relativePath = normalizeWorkspaceRelativePath(pathFromWorkspace, { allowSubdirs: true });
      } else {
        relativePath = normalizeWorkspaceRelativePath(rawValue, { allowSubdirs: true });
      }
    } catch {
      continue;
    }
    const key = `file:${relativePath.toLowerCase()}`;
    const absPath = resolveSafeChildPath(workspaceRoot, relativePath);
    let existsFile = false;
    let size: number | undefined;
    let updatedAt: number | undefined;
    let kindValue: "file" | "dir" | "other" | undefined;
    if (await exists(absPath)) {
      const info = await stat(absPath);
      kindValue = info.isFile() ? "file" : info.isDirectory() ? "dir" : "other";
      existsFile = info.isFile();
      size = info.size;
      updatedAt = info.mtimeMs;
    }
    const next = {
      id: key,
      kind: "file",
      value: relativePath,
      name: basename(relativePath),
      preview: artifactPreviewForPath(relativePath),
      confidence,
      reason,
      exists: existsFile,
      fileKind: kindValue,
      size,
      updatedAt,
      contentType: contentTypeForPath(relativePath),
    };
    const previous = results.get(key);
    if (!previous || confidence >= Number(previous.confidence ?? 0)) results.set(key, next);
  }

  return Array.from(results.values());
}

function encodeInboxId(path: string): string {
  return encodeArtifactId(path);
}

function decodeInboxId(id: string): string {
  try {
    return decodeArtifactId(id);
  } catch {
    throw new ApiError(400, "invalid_inbox_item", "Inbox item id is invalid");
  }
}

async function listArtifacts(outboxRoot: string): Promise<Array<{ id: string; path: string; size: number; updatedAt: number }>> {
  const rootResolved = resolve(outboxRoot);
  if (!(await exists(rootResolved))) return [];

  const items: Array<{ id: string; path: string; size: number; updatedAt: number }> = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = normalizeWorkspaceRelativePath(relative(rootResolved, abs), { allowSubdirs: true });
      const info = await stat(abs);
      items.push({
        id: encodeArtifactId(rel),
        path: rel,
        size: info.size,
        updatedAt: info.mtimeMs,
      });
    }
  };

  try {
    await walk(rootResolved);
  } catch {
    return [];
  }

  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

async function listInbox(inboxRoot: string): Promise<Array<{ id: string; path: string; size: number; updatedAt: number; name: string }>> {
  const items = await listArtifacts(inboxRoot);
  return items.map((item) => ({
    ...item,
    id: encodeInboxId(item.path),
    name: basename(item.path),
  }));
}

type FileSessionCatalogEntry = {
  path: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  revision: string;
};

function fileRevision(info: { mtimeMs: number; size: number }): string {
  return `${Math.floor(info.mtimeMs)}:${info.size}`;
}

function parseFileSessionTtlMs(input: unknown): number {
  const raw = typeof input === "number" && Number.isFinite(input) ? input : Number.NaN;
  if (Number.isNaN(raw)) return FILE_SESSION_DEFAULT_TTL_MS;
  const ttlMs = Math.floor(raw * 1000);
  if (ttlMs < FILE_SESSION_MIN_TTL_MS) return FILE_SESSION_MIN_TTL_MS;
  if (ttlMs > FILE_SESSION_MAX_TTL_MS) return FILE_SESSION_MAX_TTL_MS;
  return ttlMs;
}

function parseCatalogLimit(input: string | null): number {
  if (!input) return FILE_SESSION_CATALOG_DEFAULT_LIMIT;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) return FILE_SESSION_CATALOG_DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), FILE_SESSION_CATALOG_MAX_LIMIT);
}

function parseSessionCursor(input: string | null): number {
  if (!input) return 0;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function parseCatalogPathFilter(input: string | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return normalizeWorkspaceRelativePath(trimmed, { allowSubdirs: true });
}

function matchesCatalogFilter(path: string, filter: string | null): boolean {
  if (!filter) return true;
  return path === filter || path.startsWith(`${filter}/`);
}

function normalizeResolvedRelativePath(input: string): string {
  const normalized = input.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) {
    throw new ApiError(400, "invalid_path", "Path is required");
  }
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
    }
  }
  return parts.join("/");
}

async function listWorkspaceCatalogEntries(workspaceRoot: string): Promise<FileSessionCatalogEntry[]> {
  const rootResolved = resolve(workspaceRoot);
  const items: FileSessionCatalogEntry[] = [];

  const walk = async (dirPath: string) => {
    const entries = await readdir(dirPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absPath = join(dirPath, entry.name);
      const relRaw = relative(rootResolved, absPath).replace(/\\/g, "/");
      const rel = normalizeResolvedRelativePath(relRaw);

      if (entry.isDirectory()) {
        const info = await stat(absPath);
        items.push({
          path: rel,
          kind: "dir",
          size: 0,
          mtimeMs: info.mtimeMs,
          revision: fileRevision({ mtimeMs: info.mtimeMs, size: 0 }),
        });
        await walk(absPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const info = await stat(absPath);
      items.push({
        path: rel,
        kind: "file",
        size: info.size,
        mtimeMs: info.mtimeMs,
        revision: fileRevision(info),
      });
    }
  };

  if (await exists(rootResolved)) {
    await walk(rootResolved);
  }

  items.sort((a, b) => a.path.localeCompare(b.path));
  return items;
}

function parseBatchPathList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "paths must be an array");
  }
  if (!input.length) {
    throw new ApiError(400, "invalid_payload", "paths must not be empty");
  }
  if (input.length > FILE_SESSION_MAX_BATCH_ITEMS) {
    throw new ApiError(400, "invalid_payload", `paths must include <= ${FILE_SESSION_MAX_BATCH_ITEMS} items`);
  }
  return input.map((raw) => normalizeWorkspaceRelativePath(String(raw ?? ""), { allowSubdirs: true }));
}

function parseBatchWriteList(input: unknown): Array<{ path: string; contentBase64: string; ifMatchRevision?: string; force?: boolean }> {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "writes must be an array");
  }
  if (!input.length) {
    throw new ApiError(400, "invalid_payload", "writes must not be empty");
  }
  if (input.length > FILE_SESSION_MAX_BATCH_ITEMS) {
    throw new ApiError(400, "invalid_payload", `writes must include <= ${FILE_SESSION_MAX_BATCH_ITEMS} items`);
  }

  return input.map((raw) => {
    if (!raw || typeof raw !== "object") {
      throw new ApiError(400, "invalid_payload", "write entries must be objects");
    }
    const record = raw as Record<string, unknown>;
    const contentBase64 = typeof record.contentBase64 === "string" ? record.contentBase64.trim() : "";
    if (!contentBase64) {
      throw new ApiError(400, "invalid_payload", "contentBase64 is required");
    }
    const ifMatchRevision =
      typeof record.ifMatchRevision === "string" && record.ifMatchRevision.trim().length
        ? record.ifMatchRevision.trim()
        : undefined;
    return {
      path: normalizeWorkspaceRelativePath(String(record.path ?? ""), { allowSubdirs: true }),
      contentBase64,
      ...(ifMatchRevision ? { ifMatchRevision } : {}),
      ...(record.force === true ? { force: true } : {}),
    };
  });
}

function emitReloadEvent(
  reloadEvents: ReloadEventStore,
  workspace: WorkspaceInfo,
  reason: ReloadReason,
  trigger?: ReloadTrigger,
) {
  reloadEvents.recordDebounced(workspace.id, reason, trigger);
}

function buildConfigTrigger(path: string): ReloadTrigger {
  const name = path.split(/[\\/]/).filter(Boolean).pop();
  return {
    type: "config",
    name: name || "opencode.json",
    action: "updated",
    path,
  };
}

function serializeWorkspace(workspace: ServerConfig["workspaces"][number]) {
  const { opencodeUsername, opencodePassword, ...rest } = workspace;
  const opencodeDirectory = resolveOpencodeDirectory(workspace);
  const opencode =
    workspace.baseUrl || opencodeDirectory || opencodeUsername || opencodePassword
      ? {
          baseUrl: workspace.baseUrl,
          directory: opencodeDirectory ?? undefined,
          username: opencodeUsername,
          password: opencodePassword,
        }
      : undefined;
  return {
    ...rest,
    opencode,
  };
}

function createRoutes(
  config: ServerConfig,
  approvals: ApprovalService,
  tokens: TokenService,
  env: EnvService,
  onWorkspacesChanged: () => void,
): Route[] {
  const routes: Route[] = [];
  const fileSessions = new FileSessionStore();
  const googleWorkspaceFlows = new Map<string, {
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
  }>();

  const cleanupGoogleWorkspaceFlow = (flowId: string) => {
    const flow = googleWorkspaceFlows.get(flowId);
    if (!flow) return;
    flow.server.closeAllConnections?.();
    flow.server.close(() => undefined);
    googleWorkspaceFlows.delete(flowId);
  };

  const startGoogleWorkspaceConnectFlow = async () => {
    const credentials = googleWorkspaceCredentials();
    if (credentials.missing.length > 0) {
      throw new ApiError(400, "google_oauth_not_configured", `Missing Google OAuth configuration: ${credentials.missing.join(", ")}`);
    }
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
          const flow = googleWorkspaceFlows.get(flowId);
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
              scopes: typeof token.scope === "string" ? token.scope.split(/\s+/).filter(Boolean) : GOOGLE_WORKSPACE_SCOPES,
              token: {
                accessToken: token.access_token,
                refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : null,
                expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1000,
              },
              connectedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            await writeGoogleWorkspaceVault(config, record);
            flow.status = "connected";
            flow.account = account;
          } catch (exchangeError) {
            flow.status = "failed";
            flow.error = `Google authorized OpenWork, but token exchange failed: ${exchangeError instanceof Error ? exchangeError.message : String(exchangeError)}`;
          }
        } catch (callbackError) {
          const flow = googleWorkspaceFlows.get(flowId);
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
    authorizationUrl.searchParams.set("scope", GOOGLE_WORKSPACE_SCOPES.join(" "));
    authorizationUrl.searchParams.set("access_type", "offline");
    authorizationUrl.searchParams.set("prompt", "consent");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    googleWorkspaceFlows.set(flowId, {
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
      const flow = googleWorkspaceFlows.get(flowId);
      if (!flow || flow.status !== "pending") return;
      flow.status = "expired";
      flow.error = "Google Workspace OAuth timed out.";
      flow.server.closeAllConnections?.();
      flow.server.close(() => undefined);
    }, GOOGLE_WORKSPACE_AUTH_TIMEOUT_MS + 1000).unref?.();
    return { flowId, authUrl: authorizationUrl.toString(), expiresAt };
  };

  const serializeFileSession = (session: {
    id: string;
    workspaceId: string;
    createdAt: number;
    expiresAt: number;
    canWrite: boolean;
  }) => ({
    id: session.id,
    workspaceId: session.workspaceId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    ttlMs: Math.max(0, session.expiresAt - Date.now()),
    canWrite: session.canWrite,
  });

  const resolveFileSession = (ctx: RequestContext, sessionId: string) => {
    const session = fileSessions.get(sessionId);
    if (!session) {
      throw new ApiError(404, "file_session_not_found", "File session not found");
    }

    if (!ctx.actor?.tokenHash || session.actorTokenHash !== ctx.actor.tokenHash) {
      throw new ApiError(403, "forbidden", "File session does not belong to this token");
    }

    const workspace = config.workspaces.find((item) => item.id === session.workspaceId);
    if (!workspace) {
      throw new ApiError(404, "workspace_not_found", "Workspace not found for this file session");
    }

    return { session, workspace };
  };

  const recordWorkspaceFileEvent = (workspaceId: string, input: { type: "write" | "delete" | "rename" | "mkdir"; path: string; toPath?: string; revision?: string }) => {
    return fileSessions.recordWorkspaceEvent({ workspaceId, ...input });
  };

  addRoute(routes, "GET", "/health", "none", async () => {
    return jsonResponse({ ok: true, version: SERVER_VERSION, opencodeVersion: OPENCODE_VERSION, uptimeMs: Date.now() - config.startedAt });
  });

  addRoute(routes, "GET", "/w/:id/health", "none", async () => {
    return jsonResponse({ ok: true, version: SERVER_VERSION, opencodeVersion: OPENCODE_VERSION, uptimeMs: Date.now() - config.startedAt });
  });

  // Dev log sink: append browser console + error events to a file that an
  // operator (or an AI driver) can tail. Unauth on purpose because this is
  // scoped to the dev host and needs to work before clients finish wiring
  // tokens; it is also a no-op when OPENWORK_DEV_LOG_FILE is unset.
  addRoute(routes, "POST", "/dev/log", "none", async (ctx) => {
    const target = resolveDevLogPath();
    if (!target) {
      return jsonResponse({ ok: false, reason: "dev_log_disabled" }, 404);
    }
    let payload: unknown = null;
    try {
      payload = await ctx.request.json();
    } catch {
      return jsonResponse({ ok: false, reason: "invalid_json" }, 400);
    }
    const entries = Array.isArray(payload) ? payload : [payload];
    try {
      await mkdir(dirname(target), { recursive: true });
      const lines = entries
        .map((entry) => {
          try {
            const stamped = { at: new Date().toISOString(), ...(entry as Record<string, unknown>) };
            return JSON.stringify(stamped);
          } catch {
            return JSON.stringify({ at: new Date().toISOString(), raw: String(entry) });
          }
        })
        .join("\n");
      await appendFile(target, `${lines}\n`, "utf8");
    } catch (error) {
      return jsonResponse({ ok: false, reason: error instanceof Error ? error.message : String(error) }, 500);
    }
    return jsonResponse({ ok: true, count: entries.length });
  });

  addRoute(routes, "GET", "/dev/log", "none", async () => {
    // Probe response: always 200 so the client's capability probe doesn't
    // log a noisy "Failed to load resource: 404" in the browser console
    // when the sink is simply disabled. Clients should key on `ok` + `reason`
    // in the body, not on HTTP status.
    const target = resolveDevLogPath();
    if (!target) {
      return jsonResponse({ ok: false, reason: "dev_log_disabled" });
    }
    return jsonResponse({ ok: true, path: target });
  });

  addRoute(routes, "GET", "/ui", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return htmlResponse(TOY_UI_HTML);
  });

  addRoute(routes, "GET", "/w/:id/ui", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return htmlResponse(TOY_UI_HTML);
  });

  addRoute(routes, "GET", "/ui/assets/toy.css", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return cssResponse(TOY_UI_CSS);
  });

  addRoute(routes, "GET", "/ui/assets/toy.js", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return jsResponse(TOY_UI_JS);
  });

  addRoute(routes, "GET", "/ui/assets/openwork-mark.svg", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return svgResponse(TOY_UI_FAVICON_SVG);
  });

  addRoute(routes, "GET", "/w/:id/status", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({
      ok: true,
      version: SERVER_VERSION,
      opencodeVersion: OPENCODE_VERSION,
      uptimeMs: Date.now() - config.startedAt,
      readOnly: config.readOnly,
      approval: config.approval,
      corsOrigins: config.corsOrigins,
      workspaceCount: 1,
      activeWorkspaceId: workspace.id,
      workspace: serializeWorkspace(workspace),
      authorizedRoots: config.authorizedRoots,
      server: {
        host: config.host,
        port: config.port,
        configPath: config.configPath ?? null,
      },
      tokenSource: {
        client: config.tokenSource,
        host: config.hostTokenSource,
      },
    });
  });

  addRoute(routes, "GET", "/w/:id/capabilities", "client", async () => {
    return jsonResponse(buildCapabilities(config));
  });

  addRoute(routes, "GET", "/w/:id/workspaces", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({ items: [serializeWorkspace(workspace)], activeId: workspace.id });
  });

  addRoute(routes, "GET", "/status", "client", async () => {
    const active = config.workspaces[0];
    return jsonResponse({
      ok: true,
      version: SERVER_VERSION,
      opencodeVersion: OPENCODE_VERSION,
      uptimeMs: Date.now() - config.startedAt,
      readOnly: config.readOnly,
      approval: config.approval,
      corsOrigins: config.corsOrigins,
      workspaceCount: config.workspaces.length,
      activeWorkspaceId: active?.id ?? null,
      workspace: active ? serializeWorkspace(active) : null,
      authorizedRoots: config.authorizedRoots,
      server: {
        host: config.host,
        port: config.port,
        configPath: config.configPath ?? null,
      },
      tokenSource: {
        client: config.tokenSource,
        host: config.hostTokenSource,
      },
    });
  });

  addRoute(routes, "GET", "/runtime/versions", "client", async () => {
    const snapshot = await fetchRuntimeControl("/runtime/versions");
    return jsonResponse(snapshot);
  });

  addRoute(routes, "POST", "/runtime/upgrade", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const result = await fetchRuntimeControl("/runtime/upgrade", { method: "POST", body });
    return jsonResponse(result, 202);
  });

  addRoute(routes, "GET", "/w/:id/runtime/versions", "client", async () => {
    const snapshot = await fetchRuntimeControl("/runtime/versions");
    return jsonResponse(snapshot);
  });

  addRoute(routes, "POST", "/w/:id/runtime/upgrade", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const result = await fetchRuntimeControl("/runtime/upgrade", { method: "POST", body });
    return jsonResponse(result, 202);
  });

  addRoute(routes, "GET", "/whoami", "client", async (ctx) => {
    return jsonResponse({ ok: true, actor: ctx.actor ?? null });
  });

  addRoute(routes, "GET", "/capabilities", "client", async () => {
    return jsonResponse(buildCapabilities(config));
  });

  addRoute(routes, "GET", "/experimental/extensions/actions", "client", async (ctx) => {
    const extensionId = ctx.url.searchParams.get("extensionId") ?? "";
    return jsonResponse({
      ok: true,
      schemaVersion: 1,
      actions: listExperimentalExtensionActions(extensionId),
    });
  });

  addRoute(routes, "POST", "/experimental/extensions/call", "client", async (ctx) => {
    if (ctx.actor?.scope === "viewer") {
      throw new ApiError(403, "forbidden", "Viewer tokens cannot call extension actions");
    }
    const body = await readJsonBody(ctx.request);
    return jsonResponse(await callExperimentalExtensionAction(config, body));
  });

  addRoute(routes, "GET", "/experimental/google-workspace/status", "client", async () => {
    try {
      const record = await readGoogleWorkspaceVault(config);
      return jsonResponse(googleWorkspaceStatusPayload(record));
    } catch (error) {
      return jsonResponse(googleWorkspaceStatusPayload(null, { error: error instanceof Error ? error.message : String(error) }));
    }
  });

  addRoute(routes, "POST", "/experimental/google-workspace/connect/start", "client", async (ctx) => {
    if (ctx.actor?.scope === "viewer") throw new ApiError(403, "forbidden", "Viewer tokens cannot connect Google Workspace");
    return jsonResponse(await startGoogleWorkspaceConnectFlow(), 201);
  });

  addRoute(routes, "GET", "/experimental/google-workspace/connect/status/:flowId", "client", async (ctx) => {
    const flow = googleWorkspaceFlows.get(ctx.params.flowId);
    if (!flow) throw new ApiError(404, "google_oauth_flow_not_found", "Google Workspace connection flow not found");
    if (flow.status === "pending" && flow.expiresAt <= Date.now()) {
      flow.status = "expired";
      flow.error = "Google Workspace OAuth timed out.";
    }
    const record = flow.status === "connected" ? await readGoogleWorkspaceVault(config) : null;
    const payload = {
      flowId: flow.flowId,
      status: flow.status,
      expiresAt: flow.expiresAt,
      error: flow.error,
      googleWorkspace: record ? googleWorkspaceStatusPayload(record) : null,
    };
    if (flow.status !== "pending") setTimeout(() => cleanupGoogleWorkspaceFlow(flow.flowId), 1000).unref?.();
    return jsonResponse(payload);
  });

  addRoute(routes, "POST", "/experimental/google-workspace/disconnect", "client", async (ctx) => {
    if (ctx.actor?.scope === "viewer") throw new ApiError(403, "forbidden", "Viewer tokens cannot disconnect Google Workspace");
    const record = await readGoogleWorkspaceVault(config);
    const token = isRecord(record?.token) ? record.token : null;
    const revokeToken = typeof token?.refreshToken === "string" ? token.refreshToken : typeof token?.accessToken === "string" ? token.accessToken : "";
    let revokeError: Error | null = null;
    if (revokeToken) {
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
    await removeGoogleWorkspaceVault(config);
    return jsonResponse(googleWorkspaceStatusPayload(null, revokeError ? { error: `Local Google Workspace tokens were removed, but Google token revocation failed: ${revokeError.message}` } : { testStatus: "Google Workspace access revoked and local tokens removed." }));
  });

  addRoute(routes, "POST", "/experimental/google-workspace/test", "client", async () => {
    return jsonResponse(await googleWorkspaceTestConnection(config));
  });

  addRoute(routes, "POST", "/experimental/google-workspace/smoke-test", "client", async () => {
    return jsonResponse(await googleWorkspaceRunScopeSmokeTest(config));
  });

  addRoute(routes, "GET", "/workspaces", "client", async () => {
    const active = config.workspaces[0] ?? null;
    const items = config.workspaces.map(serializeWorkspace);
    return jsonResponse({ items, workspaces: items, activeId: active?.id ?? null });
  });

  addRoute(routes, "GET", "/tokens", "host", async () => {
    const items = await tokens.list();
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/tokens", "host", async (ctx) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    const scopeRaw = typeof body.scope === "string" ? body.scope.trim() : "";
    const scope = scopeRaw === "owner" || scopeRaw === "collaborator" || scopeRaw === "viewer" ? scopeRaw : null;
    if (!scope) {
      throw new ApiError(400, "invalid_scope", "Token scope must be owner, collaborator, or viewer");
    }
    const label = typeof body.label === "string" ? body.label.trim() : undefined;
    const issued = await tokens.create(scope, { label });
    return jsonResponse(issued, 201);
  });

  addRoute(routes, "DELETE", "/tokens/:id", "host", async (ctx) => {
    ensureWritable(config);
    const ok = await tokens.revoke(ctx.params.id);
    if (!ok) {
      throw new ApiError(404, "token_not_found", "Token not found");
    }
    return jsonResponse({ ok: true });
  });

  function rethrowEnvStoreReadError(error: unknown): never {
    if (error instanceof EnvStoreReadError) {
      throw new ApiError(
        409,
        error.code,
        "Environment variable store is invalid. Fix or remove the local env file before editing.",
      );
    }
    throw error;
  }

  // User-level env vars (see apps/app/pr/environment-variables.md). All routes
  // require the desktop host token (not owner bearer tokens) because values are
  // returned raw; the React pane masks them only for display. Reload semantics
  // are driven from the UI after a write; this surface is user-scoped, not
  // workspace-scoped, so no audit.
  addRoute(routes, "GET", "/env", "host-token", async () => {
    const items = await env.list().catch(rethrowEnvStoreReadError);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/env/keys", "host-token", async () => {
    const items = await env.list().catch(rethrowEnvStoreReadError);
    return jsonResponse({ keys: items.map((item) => item.key) });
  });

  addRoute(routes, "PUT", "/env", "host-token", async (ctx) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    const rawEntries = Array.isArray(body.entries)
      ? body.entries
      : [{ key: body.key, value: body.value }];
    const entries: Array<{ key: string; value: string }> = [];
    for (const raw of rawEntries) {
      if (!raw || typeof raw !== "object") {
        throw new ApiError(400, "invalid_entry", "Each entry must be an object");
      }
      const candidate = raw as { key?: unknown; value?: unknown };
      const key = typeof candidate.key === "string" ? candidate.key.trim() : "";
      const value = typeof candidate.value === "string" ? candidate.value : "";
      if (!isValidEnvKey(key)) {
        throw new ApiError(400, "invalid_env_key", "Invalid environment variable name");
      }
      entries.push({ key, value });
    }
    if (entries.length === 0) {
      throw new ApiError(400, "no_entries", "No entries provided");
    }
    try {
      await env.upsertMany(entries);
    } catch (error) {
      if (error instanceof EnvStoreReadError) {
        rethrowEnvStoreReadError(error);
      }
      if (error instanceof InvalidEnvKeyError) {
        throw new ApiError(
          400,
          error.code,
          error.code === "reserved_env_key"
            ? "Environment variable name is reserved for OpenWork internals"
            : "Invalid environment variable name",
        );
      }
      throw error;
    }
    return jsonResponse({ ok: true, count: entries.length });
  });

  addRoute(routes, "DELETE", "/env/:key", "host-token", async (ctx) => {
    ensureWritable(config);
    const key = ctx.params.key;
    if (!isValidEnvKey(key)) {
      throw new ApiError(400, "invalid_env_key", "Invalid environment variable name");
    }
    const removed = await env.delete(key).catch(rethrowEnvStoreReadError);
    if (!removed) {
      throw new ApiError(404, "env_not_found", "Environment variable not found");
    }
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/voice/realtime/session", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    return jsonResponse(await createOpenAiRealtimeVoiceSession(env, body));
  });

  addRoute(routes, "POST", "/workspaces/local", "host", async (ctx) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    const folderPath = typeof body.folderPath === "string" ? body.folderPath.trim() : "";
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : basename(folderPath || "Workspace");
    const preset = typeof body.preset === "string" && body.preset.trim() ? body.preset.trim() : "starter";

    if (!folderPath) {
      throw new ApiError(400, "invalid_payload", "folderPath is required");
    }

    const workspacePath = resolve(folderPath);
    await ensureDir(workspacePath);
    await ensureWorkspaceFiles(workspacePath, preset);

    const workspace: WorkspaceInfo = {
      id: workspaceIdForPath(workspacePath),
      name,
      path: workspacePath,
      preset,
      workspaceType: "local",
      ...inheritWorkspaceOpencodeConnection(config),
    };

    config.workspaces = [workspace, ...config.workspaces.filter((entry) => entry.id !== workspace.id)];
    if (!config.authorizedRoots.some((root) => resolve(root) === workspacePath)) {
      config.authorizedRoots = [...config.authorizedRoots, workspacePath];
    }
    const persisted = await persistServerWorkspaceState(config);
    onWorkspacesChanged();

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.create",
      target: workspace.path,
      summary: `Created workspace ${name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({
      activeId: workspace.id,
      workspaces: config.workspaces.map(serializeWorkspace),
      persisted,
    }, 201);
  });

  addRoute(routes, "PATCH", "/workspaces/:id/display-name", "host", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const nextDisplayName = typeof body.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim()
      : undefined;

    config.workspaces = config.workspaces.map((entry) =>
      entry.id === workspace.id
        ? {
            ...entry,
            displayName: nextDisplayName,
            name: nextDisplayName ?? entry.name,
          }
        : entry,
    );

    const persisted = await persistServerWorkspaceState(config);
    onWorkspacesChanged();

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.rename",
      target: workspace.path,
      summary: `Updated workspace display name${nextDisplayName ? ` to ${nextDisplayName}` : ""}`,
      timestamp: Date.now(),
    });

    return jsonResponse({
      activeId: config.workspaces[0]?.id ?? null,
      workspaces: config.workspaces.map(serializeWorkspace),
      persisted,
    });
  });

  addRoute(routes, "POST", "/workspaces/:id/activate", "host", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    config.workspaces = [
      workspace,
      ...config.workspaces.filter((entry) => entry.id !== workspace.id),
    ];
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.activate",
      target: "workspace",
      summary: "Switched active workspace",
      timestamp: Date.now(),
    });
    const connection = resolveWorkspaceOpencodeConnection(config, workspace);
    if (connection.baseUrl?.trim()) {
      await reloadOpencodeEngine(config, workspace);
    }
    return jsonResponse({ activeId: workspace.id, workspace: serializeWorkspace(workspace), persisted: false });
  });

  addRoute(routes, "DELETE", "/workspaces/:id", "host", async (ctx) => {
    ensureWritable(config);

    const workspace = await resolveWorkspace(config, ctx.params.id);

    const before = config.workspaces.length;
    config.workspaces = config.workspaces.filter((entry) => entry.id !== workspace.id);
    const deleted = before !== config.workspaces.length;

    if (deleted) {
      // Only remove exact matches; authorizedRoots can contain broader entries.
      config.authorizedRoots = config.authorizedRoots.filter((root) => resolve(root) !== resolve(workspace.path));
    }
    const persisted = await persistServerWorkspaceState(config);
    onWorkspacesChanged();

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.delete",
      target: "workspace",
      summary: "Deleted workspace from OpenWork server",
      timestamp: Date.now(),
    });

    const active = config.workspaces[0] ?? null;
    return jsonResponse({
      ok: true,
      deleted,
      persisted,
      activeId: active?.id ?? null,
      items: config.workspaces.map(serializeWorkspace),
      workspaces: config.workspaces.map(serializeWorkspace),
    });
  });

  addRoute(routes, "GET", "/workspace/:id/config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const opencode = await readOpencodeConfig(workspace.path);
    const openwork = await readOpenworkConfig(workspace.path);
    const lastAudit = await readLastAudit(workspace.path, workspace.id);
    return jsonResponse({ opencode, openwork, updatedAt: lastAudit?.timestamp ?? null });
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const scope = normalizeOpencodeScope(ctx.url.searchParams.get("scope"));
    const configPath = resolveOpencodeConfigFilePath(scope, workspace.path);
    const result = await readRawOpencodeConfig(configPath);
    return jsonResponse({ path: configPath, exists: result.exists, content: result.content });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-config", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const scope = normalizeOpencodeScope(typeof body.scope === "string" ? body.scope : null);
    const content = typeof body.content === "string" ? body.content : null;
    if (content === null) {
      throw new ApiError(400, "invalid_payload", "content must be a string");
    }

    const configPath = resolveOpencodeConfigFilePath(scope, workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: scope === "global" ? "config.global.write" : "config.write",
      summary: `Write ${scope} OpenCode config`,
      paths: [configPath],
    });

    const nextContent = content.endsWith("\n") ? content : `${content}\n`;
    const current = await readRawOpencodeConfig(configPath);
    const changed = !current.exists || current.content !== nextContent;
    if (changed) {
      await ensureDir(dirname(configPath));
      await writeFile(configPath, nextContent, "utf8");
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: scope === "global" ? "config.global.write" : "config.write",
      target: configPath,
      summary: `Updated ${scope} OpenCode config`,
      timestamp: Date.now(),
    });

    if (scope === "project" && changed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(configPath));
    }

    return jsonResponse({
      ok: true,
      status: 0,
      stdout: `Wrote ${configPath}`,
      stderr: "",
    });
  });

  addRoute(routes, "GET", "/workspace/:id/audit", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const limitParam = ctx.url.searchParams.get("limit");
    const parsed = limitParam ? Number(limitParam) : NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
    const items = await readAuditEntries(workspace.path, workspace.id, limit);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listWorkspaceSessions(config, workspace, {
      roots: parseOptionalBoolean(ctx.url.searchParams.get("roots"), "roots"),
      start: parseOptionalNonNegativeInteger(ctx.url.searchParams.get("start"), "start"),
      search: ctx.url.searchParams.get("search")?.trim() || undefined,
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const item = await readWorkspaceSession(config, workspace, sessionId);
    return jsonResponse({ item });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/messages", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const items = await readWorkspaceSessionMessages(config, workspace, sessionId, {
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/snapshot", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const item = await readWorkspaceSessionSnapshot(config, workspace, sessionId, {
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    return jsonResponse({ item });
  });

  addRoute(routes, "DELETE", "/workspace/:id/sessions/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");

    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }

    // OpenCode session deletion via the upstream API.
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    unwrapOpencodeResult(await opencode.session.delete({ sessionID: sessionId }), `/session/${encodeURIComponent(sessionId)}`);

    return jsonResponse({ ok: true });
  });

  addRoute(routes, "PATCH", "/workspace/:id/config", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const opencode = body.opencode as Record<string, unknown> | undefined;
    const openwork = body.openwork as Record<string, unknown> | undefined;

    if (!opencode && !openwork) {
      throw new ApiError(400, "invalid_payload", "opencode or openwork updates required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.patch",
      summary: "Patch workspace config",
      paths: [opencode ? opencodeConfigPath(workspace.path) : null, openwork ? openworkConfigPath(workspace.path) : null].filter(Boolean) as string[],
    });

    const configFingerprintBefore = opencode
      ? await computeReloadFingerprint(workspace.path, "config")
      : null;

    if (opencode) {
      const configPath = opencodeConfigPath(workspace.path);
      const nextOpencode = ensurePlainObject(opencode);
      const { permission, provider, ...topLevelUpdates } = nextOpencode;

      if (Object.keys(topLevelUpdates).length) {
        await updateJsoncTopLevel(configPath, topLevelUpdates);
      }

      const providerUpdate = ensurePlainObject(provider);
      for (const [providerId, providerConfig] of Object.entries(providerUpdate)) {
        await updateJsoncPath(configPath, ["provider", providerId], providerConfig);
      }

      const permissionUpdate = ensurePlainObject(permission);
      if (Object.prototype.hasOwnProperty.call(permissionUpdate, "external_directory")) {
        const existingOpencode = await readOpencodeConfig(workspace.path);
        const existingPermission = ensurePlainObject(existingOpencode.permission);
        const nextExternalDirectory = permissionUpdate.external_directory;
        const existingPermissionKeys = Object.keys(existingPermission);
        const removePermissionParent =
          typeof nextExternalDirectory === "undefined" &&
          (existingPermissionKeys.length === 0 ||
            (existingPermissionKeys.length === 1 && Object.prototype.hasOwnProperty.call(existingPermission, "external_directory")));

        if (removePermissionParent) {
          await updateJsoncPath(configPath, ["permission"], undefined);
        } else {
          await updateJsoncPath(configPath, ["permission", "external_directory"], nextExternalDirectory);
        }
      }
    }
    if (openwork) {
      await writeOpenworkConfig(workspace.path, openwork, true);
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.patch",
      target: "opencode.json",
      summary: "Patched workspace config",
      timestamp: Date.now(),
    });

    if (opencode && configFingerprintBefore !== await computeReloadFingerprint(workspace.path, "config")) {
      emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(opencodeConfigPath(workspace.path)));
    }

    return jsonResponse({ updatedAt: Date.now() });
  });

  addRoute(routes, "GET", "/workspace/:id/events", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sinceRaw = ctx.url.searchParams.get("since");
    const since = sinceRaw ? Number(sinceRaw) : undefined;
    const items = ctx.reloadEvents.list(workspace.id, since);
    return jsonResponse({ items, cursor: ctx.reloadEvents.cursor(), workspaceId: workspace.id, disabled: false });
  });

  addRoute(routes, "POST", "/workspace/:id/engine/reload", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    requireClientScope(ctx, "collaborator");

      await reloadOpencodeEngine(config, workspace);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "engine.reload",
      target: workspace.baseUrl ?? "opencode",
      summary: "Reloaded workspace engine",
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, reloadedAt: Date.now() });
  });

  addRoute(routes, "GET", "/workspace/:id/inbox", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveInboxEnabled()) {
      return jsonResponse({ items: [] });
    }
    const inboxRoot = resolveInboxDir(workspace.path);
    const items = await listInbox(inboxRoot);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/inbox/:inboxId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveInboxEnabled()) {
      throw new ApiError(404, "inbox_disabled", "Workspace inbox is disabled");
    }
    const inboxRoot = resolveInboxDir(workspace.path);
    const relativePath = decodeInboxId(ctx.params.inboxId);
    const absPath = resolveSafeChildPath(inboxRoot, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Length", String(info.size));
    headers.set("Content-Disposition", `attachment; filename=\"${basename(relativePath)}\"`);
    const stream = Readable.toWeb(createReadStream(absPath)) as unknown as ReadableStream;
    return new Response(stream, { status: 200, headers });
  });

  addRoute(routes, "POST", "/workspace/:id/inbox", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    if (!resolveInboxEnabled()) {
      throw new ApiError(404, "inbox_disabled", "Workspace inbox is disabled");
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);

    const contentType = ctx.request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      throw new ApiError(400, "invalid_payload", "Expected multipart/form-data");
    }
    const form = await ctx.request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "file_required", "Form field 'file' is required");
    }

    const queryPath = (ctx.url.searchParams.get("path") ?? "").trim();
    const formPath = typeof form.get("path") === "string" ? String(form.get("path") || "").trim() : "";
    const requestedPath = queryPath || formPath || file.name;

    const relativePath = normalizeWorkspaceRelativePath(requestedPath, { allowSubdirs: true });
    const inboxRoot = resolveInboxDir(workspace.path);
    const dest = resolveSafeChildPath(inboxRoot, relativePath);
    const maxBytes = resolveInboxMaxBytes();
    if (file.size > maxBytes) {
      throw new ApiError(413, "file_too_large", "File exceeds upload limit", { maxBytes, size: file.size });
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "workspace.inbox.upload",
      summary: `Upload ${relativePath} to inbox`,
      paths: [dest],
    });

    await ensureDir(dirname(dest));
    const bytes = Buffer.from(await file.arrayBuffer());
    const tmp = `${dest}.tmp-${shortId()}`;
    await writeFile(tmp, bytes);
    await rename(tmp, dest);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "workspace.inbox.upload",
      target: dest,
      summary: `Uploaded ${relativePath} to inbox`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, path: relativePath, bytes: file.size });
  });

  addRoute(routes, "GET", "/workspace/:id/artifacts", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveOutboxEnabled()) {
      return jsonResponse({ items: [] });
    }
    const outboxRoot = resolveOutboxDir(workspace.path);
    const items = await listArtifacts(outboxRoot);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/artifacts/:artifactId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveOutboxEnabled()) {
      throw new ApiError(404, "outbox_disabled", "Workspace outbox is disabled");
    }
    const outboxRoot = resolveOutboxDir(workspace.path);
    const relativePath = decodeArtifactId(ctx.params.artifactId);
    const absPath = resolveSafeChildPath(outboxRoot, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "artifact_not_found", "Artifact not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "artifact_not_found", "Artifact not found");
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Length", String(info.size));
    headers.set("Content-Disposition", `attachment; filename="${basename(relativePath)}"`);
    const stream = Readable.toWeb(createReadStream(absPath)) as unknown as ReadableStream;
    return new Response(stream, { status: 200, headers });
  });

  addRoute(routes, "POST", "/workspace/:id/artifacts/resolve", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const items = await resolveWorkspaceArtifactTargets(workspace.path, (body as Record<string, unknown>).targets);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/files/sessions", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const ttlMs = parseFileSessionTtlMs((body as Record<string, unknown>).ttlSeconds);
    const requestWrite = (body as Record<string, unknown>).write !== false;
    const canWrite =
      requestWrite &&
      !config.readOnly &&
      scopeRank(ctx.actor?.scope ?? "viewer") >= scopeRank("collaborator");

    const session = fileSessions.create({
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      actorTokenHash: ctx.actor?.tokenHash ?? "",
      actorScope: ctx.actor?.scope ?? "viewer",
      canWrite,
      ttlMs,
    });

    return jsonResponse({ session: serializeFileSession(session) });
  });

  addRoute(routes, "POST", "/files/sessions/:sessionId/renew", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const ttlMs = parseFileSessionTtlMs((body as Record<string, unknown>).ttlSeconds);
    const { session } = resolveFileSession(ctx, ctx.params.sessionId);
    const renewed = fileSessions.renew(session.id, ttlMs);
    if (!renewed) {
      throw new ApiError(404, "file_session_not_found", "File session not found");
    }
    return jsonResponse({ session: serializeFileSession(renewed) });
  });

  addRoute(routes, "DELETE", "/files/sessions/:sessionId", "client", async (ctx) => {
    const { session } = resolveFileSession(ctx, ctx.params.sessionId);
    fileSessions.close(session.id);
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/files/sessions/:sessionId/catalog/snapshot", "client", async (ctx) => {
    const { workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    const prefix = parseCatalogPathFilter(ctx.url.searchParams.get("prefix"));
    const after = parseCatalogPathFilter(ctx.url.searchParams.get("after"));
    const includeDirs = ctx.url.searchParams.get("includeDirs") !== "false";
    const limit = parseCatalogLimit(ctx.url.searchParams.get("limit"));

    const entries = await listWorkspaceCatalogEntries(workspace.path);
    const filtered = entries.filter((entry) => {
      if (!includeDirs && entry.kind === "dir") return false;
      if (!matchesCatalogFilter(entry.path, prefix)) return false;
      if (after && entry.path <= after) return false;
      return true;
    });

    const items = filtered.slice(0, limit);
    const truncated = filtered.length > items.length;
    const nextAfter = truncated ? items[items.length - 1]?.path : undefined;
    const events = fileSessions.listWorkspaceEvents(workspace.id, Number.MAX_SAFE_INTEGER);

    return jsonResponse({
      sessionId: ctx.params.sessionId,
      workspaceId: workspace.id,
      generatedAt: Date.now(),
      cursor: events.cursor,
      total: filtered.length,
      truncated,
      nextAfter,
      items,
    });
  });

  addRoute(routes, "GET", "/files/sessions/:sessionId/catalog/events", "client", async (ctx) => {
    const { workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    const since = parseSessionCursor(ctx.url.searchParams.get("since"));
    const events = fileSessions.listWorkspaceEvents(workspace.id, since);
    return jsonResponse(events);
  });

  addRoute(routes, "POST", "/files/sessions/:sessionId/read-batch", "client", async (ctx) => {
    const { workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    const body = await readJsonBody(ctx.request);
    const paths = parseBatchPathList((body as Record<string, unknown>).paths);
    const items: Array<Record<string, unknown>> = [];

    for (const relativePath of paths) {
      try {
        const absPath = resolveSafeChildPath(workspace.path, relativePath);
        if (!(await exists(absPath))) {
          items.push({ ok: false, path: relativePath, code: "file_not_found", message: "File not found" });
          continue;
        }
        const info = await stat(absPath);
        if (!info.isFile()) {
          items.push({ ok: false, path: relativePath, code: "file_not_found", message: "File not found" });
          continue;
        }
        if (info.size > FILE_SESSION_MAX_FILE_BYTES) {
          items.push({
            ok: false,
            path: relativePath,
            code: "file_too_large",
            message: "File exceeds size limit",
            maxBytes: FILE_SESSION_MAX_FILE_BYTES,
            size: info.size,
          });
          continue;
        }

        const content = await readFile(absPath);
        items.push({
          ok: true,
          path: relativePath,
          kind: "file",
          bytes: info.size,
          updatedAt: info.mtimeMs,
          revision: fileRevision(info),
          contentBase64: content.toString("base64"),
        });
      } catch (error) {
        const message = error instanceof ApiError ? error.message : "Unable to read file";
        const code = error instanceof ApiError ? error.code : "read_failed";
        items.push({ ok: false, path: relativePath, code, message });
      }
    }

    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/files/sessions/:sessionId/write-batch", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const { session, workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    if (!session.canWrite) {
      throw new ApiError(403, "forbidden", "File session is read-only");
    }

    const body = await readJsonBody(ctx.request);
    const writes = parseBatchWriteList((body as Record<string, unknown>).writes);
    const items: Array<Record<string, unknown>> = [];

    const plan: Array<{
      path: string;
      absPath: string;
      bytes: Buffer;
      ifMatchRevision?: string;
      force?: boolean;
      beforeRevision: string | null;
    }> = [];

    for (const write of writes) {
      try {
        const absPath = resolveSafeChildPath(workspace.path, write.path);
        const bytes = Buffer.from(write.contentBase64, "base64");
        if (bytes.byteLength > FILE_SESSION_MAX_FILE_BYTES) {
          items.push({
            ok: false,
            path: write.path,
            code: "file_too_large",
            message: "File exceeds size limit",
            maxBytes: FILE_SESSION_MAX_FILE_BYTES,
            size: bytes.byteLength,
          });
          continue;
        }

        const before = (await exists(absPath)) ? await stat(absPath) : null;
        if (before && !before.isFile()) {
          items.push({ ok: false, path: write.path, code: "invalid_path", message: "Path must point to a file" });
          continue;
        }
        const beforeRevision = before ? fileRevision(before) : null;
        if (!write.force && write.ifMatchRevision && write.ifMatchRevision !== beforeRevision) {
          items.push({
            ok: false,
            path: write.path,
            code: "conflict",
            message: "File changed since it was loaded",
            expectedRevision: write.ifMatchRevision,
            currentRevision: beforeRevision,
          });
          continue;
        }

        plan.push({
          path: write.path,
          absPath,
          bytes,
          beforeRevision,
          ...(write.ifMatchRevision ? { ifMatchRevision: write.ifMatchRevision } : {}),
          ...(write.force ? { force: true } : {}),
        });
      } catch (error) {
        const message = error instanceof ApiError ? error.message : "Invalid write request";
        const code = error instanceof ApiError ? error.code : "invalid_payload";
        items.push({ ok: false, path: write.path, code, message });
      }
    }

    if (plan.length) {
      await requireApproval(ctx, {
        workspaceId: workspace.id,
        action: "workspace.files.session.write",
        summary: `Write ${plan.length} file(s) via file session`,
        paths: plan.map((item) => item.absPath),
      });
    }

    for (const entry of plan) {
      try {
        const before = (await exists(entry.absPath)) ? await stat(entry.absPath) : null;
        const currentRevision = before ? fileRevision(before) : null;
        if (!entry.force && entry.ifMatchRevision && currentRevision !== entry.ifMatchRevision) {
          items.push({
            ok: false,
            path: entry.path,
            code: "conflict",
            message: "File changed before write could be applied",
            expectedRevision: entry.ifMatchRevision,
            currentRevision,
          });
          continue;
        }

        await ensureDir(dirname(entry.absPath));
        const tmp = `${entry.absPath}.tmp-${shortId()}`;
        await writeFile(tmp, entry.bytes);
        await rename(tmp, entry.absPath);
        const after = await stat(entry.absPath);
        const revision = fileRevision(after);

        recordWorkspaceFileEvent(workspace.id, { type: "write", path: entry.path, revision });

        await recordAudit(workspace.path, {
          id: shortId(),
          workspaceId: workspace.id,
          actor: ctx.actor ?? { type: "remote" },
          action: "workspace.files.session.write",
          target: entry.absPath,
          summary: `Wrote ${entry.path} via file session`,
          timestamp: Date.now(),
        });

        items.push({
          ok: true,
          path: entry.path,
          bytes: entry.bytes.byteLength,
          updatedAt: after.mtimeMs,
          revision,
          previousRevision: entry.beforeRevision,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to write file";
        items.push({ ok: false, path: entry.path, code: "write_failed", message });
      }
    }

    const events = fileSessions.listWorkspaceEvents(workspace.id, Number.MAX_SAFE_INTEGER);
    return jsonResponse({ items, cursor: events.cursor });
  });

  addRoute(routes, "POST", "/files/sessions/:sessionId/ops", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const { session, workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    if (!session.canWrite) {
      throw new ApiError(403, "forbidden", "File session is read-only");
    }

    const body = await readJsonBody(ctx.request);
    const operations = Array.isArray((body as Record<string, unknown>).operations)
      ? ((body as Record<string, unknown>).operations as Array<Record<string, unknown>>)
      : null;
    if (!operations || !operations.length) {
      throw new ApiError(400, "invalid_payload", "operations must be a non-empty array");
    }
    if (operations.length > FILE_SESSION_MAX_BATCH_ITEMS) {
      throw new ApiError(400, "invalid_payload", `operations must include <= ${FILE_SESSION_MAX_BATCH_ITEMS} items`);
    }

    const items: Array<Record<string, unknown>> = [];
    const approvalPaths: string[] = [];
    for (const op of operations) {
      if (typeof op?.path === "string" && op.path.trim()) {
        approvalPaths.push(resolveSafeChildPath(workspace.path, normalizeWorkspaceRelativePath(op.path, { allowSubdirs: true })));
      }
      if (typeof op?.from === "string" && op.from.trim()) {
        approvalPaths.push(resolveSafeChildPath(workspace.path, normalizeWorkspaceRelativePath(op.from, { allowSubdirs: true })));
      }
      if (typeof op?.to === "string" && op.to.trim()) {
        approvalPaths.push(resolveSafeChildPath(workspace.path, normalizeWorkspaceRelativePath(op.to, { allowSubdirs: true })));
      }
    }

    if (approvalPaths.length) {
      await requireApproval(ctx, {
        workspaceId: workspace.id,
        action: "workspace.files.session.ops",
        summary: `Apply ${operations.length} file operation(s) via file session`,
        paths: approvalPaths,
      });
    }

    for (const op of operations) {
      const type = String(op.type ?? "").trim();
      try {
        if (type === "mkdir") {
          const path = normalizeWorkspaceRelativePath(String(op.path ?? ""), { allowSubdirs: true });
          const absPath = resolveSafeChildPath(workspace.path, path);
          await ensureDir(absPath);
          recordWorkspaceFileEvent(workspace.id, { type: "mkdir", path });
          items.push({ ok: true, type, path });
          continue;
        }

        if (type === "delete") {
          const path = normalizeWorkspaceRelativePath(String(op.path ?? ""), { allowSubdirs: true });
          const absPath = resolveSafeChildPath(workspace.path, path);
          if (!(await exists(absPath))) {
            items.push({ ok: false, type, path, code: "file_not_found", message: "Path not found" });
            continue;
          }
          await rm(absPath, { recursive: op.recursive === true, force: false });
          recordWorkspaceFileEvent(workspace.id, { type: "delete", path });
          items.push({ ok: true, type, path });
          continue;
        }

        if (type === "rename") {
          const from = normalizeWorkspaceRelativePath(String(op.from ?? ""), { allowSubdirs: true });
          const to = normalizeWorkspaceRelativePath(String(op.to ?? ""), { allowSubdirs: true });
          const fromAbs = resolveSafeChildPath(workspace.path, from);
          const toAbs = resolveSafeChildPath(workspace.path, to);
          if (!(await exists(fromAbs))) {
            items.push({ ok: false, type, from, to, code: "file_not_found", message: "Source path not found" });
            continue;
          }
          await ensureDir(dirname(toAbs));
          await rename(fromAbs, toAbs);
          recordWorkspaceFileEvent(workspace.id, { type: "rename", path: from, toPath: to });
          items.push({ ok: true, type, from, to });
          continue;
        }

        items.push({ ok: false, type, code: "invalid_operation", message: `Unsupported operation type: ${type}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Operation failed";
        items.push({ ok: false, type, code: "operation_failed", message });
      }
    }

    const events = fileSessions.listWorkspaceEvents(workspace.id, Number.MAX_SAFE_INTEGER);
    return jsonResponse({ items, cursor: events.cursor });
  });

  addRoute(routes, "GET", "/workspace/:id/files/content", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const requested = (ctx.url.searchParams.get("path") ?? "").trim();
    const relativePath = normalizeWorkspaceRelativePath(requested, { allowSubdirs: true });
    if (!isSupportedWorkspaceTextFilePath(relativePath)) {
      throw new ApiError(400, "invalid_path", "Only supported text artifact files can be read inline");
    }

    const absPath = resolveSafeChildPath(workspace.path, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "file_not_found", "File not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "file_not_found", "File not found");
    }

    const maxBytes = FILE_SESSION_MAX_FILE_BYTES;
    if (info.size > maxBytes) {
      throw new ApiError(413, "file_too_large", "File exceeds size limit", { maxBytes, size: info.size });
    }

    const content = await readFile(absPath, "utf8");
    return jsonResponse({ path: relativePath, content, bytes: info.size, updatedAt: info.mtimeMs });
  });

  addRoute(routes, "GET", "/workspace/:id/files/stat", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const requested = (ctx.url.searchParams.get("path") ?? "").trim();
    const relativePath = normalizeWorkspaceRelativePath(requested, { allowSubdirs: true });
    const absPath = resolveSafeChildPath(workspace.path, relativePath);
    if (!(await exists(absPath))) {
      return jsonResponse({ ok: true, path: relativePath, exists: false });
    }
    const info = await stat(absPath);
    return jsonResponse({
      ok: true,
      path: relativePath,
      exists: true,
      kind: info.isFile() ? "file" : info.isDirectory() ? "dir" : "other",
      size: info.size,
      updatedAt: info.mtimeMs,
    });
  });

  addRoute(routes, "GET", "/workspace/:id/files/raw", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const requested = (ctx.url.searchParams.get("path") ?? "").trim();
    const relativePath = normalizeWorkspaceRelativePath(requested, { allowSubdirs: true });
    const absPath = resolveSafeChildPath(workspace.path, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "file_not_found", "File not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "file_not_found", "File not found");
    }

    const headers = new Headers();
    headers.set("Content-Type", contentTypeForPath(relativePath));
    headers.set("Content-Length", String(info.size));
    headers.set("Content-Disposition", `inline; filename="${basename(relativePath)}"`);
    const stream = Readable.toWeb(createReadStream(absPath)) as unknown as ReadableStream;
    return new Response(stream, { status: 200, headers });
  });

  addRoute(routes, "POST", "/workspace/:id/files/raw", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const requestedPath = String(body.path ?? "");
    const relativePath = normalizeWorkspaceRelativePath(requestedPath, { allowSubdirs: true });
    if (typeof body.dataBase64 !== "string") {
      throw new ApiError(400, "invalid_payload", "dataBase64 must be a string");
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.dataBase64, "base64");
    } catch {
      throw new ApiError(400, "invalid_payload", "dataBase64 is invalid");
    }
    const maxBytes = FILE_SESSION_MAX_FILE_BYTES;
    if (bytes.byteLength > maxBytes) {
      throw new ApiError(413, "file_too_large", "File exceeds size limit", { maxBytes, size: bytes.byteLength });
    }

    const baseUpdatedAtRaw = body.baseUpdatedAt;
    const baseUpdatedAt =
      typeof baseUpdatedAtRaw === "number" && Number.isFinite(baseUpdatedAtRaw) ? baseUpdatedAtRaw : null;
    const force = body.force === true;
    const absPath = resolveSafeChildPath(workspace.path, relativePath);
    const before = (await exists(absPath)) ? await stat(absPath) : null;
    if (before && !before.isFile()) {
      throw new ApiError(400, "invalid_path", "Path must point to a file");
    }
    const beforeUpdatedAt = before ? before.mtimeMs : null;
    if (!force && beforeUpdatedAt !== null && baseUpdatedAt !== null && beforeUpdatedAt !== baseUpdatedAt) {
      throw new ApiError(409, "conflict", "File changed since it was loaded", { baseUpdatedAt, currentUpdatedAt: beforeUpdatedAt });
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "workspace.file.write",
      summary: `Write ${relativePath}`,
      paths: [absPath],
    });

    await ensureDir(dirname(absPath));
    const tmp = `${absPath}.tmp-${shortId()}`;
    await writeFile(tmp, bytes);
    await rename(tmp, absPath);
    const after = await stat(absPath);
    const revision = fileRevision(after);
    recordWorkspaceFileEvent(workspace.id, { type: "write", path: relativePath, revision });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "workspace.file.write",
      target: absPath,
      summary: `Wrote ${relativePath}`,
      timestamp: Date.now(),
    });
    return jsonResponse({ ok: true, path: relativePath, bytes: bytes.byteLength, updatedAt: after.mtimeMs, revision });
  });

  addRoute(routes, "POST", "/workspace/:id/files/content", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);

    const requestedPath = String(body.path ?? "");
    const relativePath = normalizeWorkspaceRelativePath(requestedPath, { allowSubdirs: true });
    if (!isSupportedWorkspaceTextFilePath(relativePath)) {
      throw new ApiError(400, "invalid_path", "Only supported text artifact files can be edited inline");
    }

    if (typeof body.content !== "string") {
      throw new ApiError(400, "invalid_payload", "content must be a string");
    }
    const content = body.content;
    const bytes = Buffer.byteLength(content, "utf8");
    const maxBytes = FILE_SESSION_MAX_FILE_BYTES;
    if (bytes > maxBytes) {
      throw new ApiError(413, "file_too_large", "File exceeds size limit", { maxBytes, size: bytes });
    }

    const baseUpdatedAtRaw = body.baseUpdatedAt;
    const baseUpdatedAt =
      typeof baseUpdatedAtRaw === "number" && Number.isFinite(baseUpdatedAtRaw) ? baseUpdatedAtRaw : null;
    const force = body.force === true;

    const absPath = resolveSafeChildPath(workspace.path, relativePath);

    const before = (await exists(absPath)) ? await stat(absPath) : null;
    if (before && !before.isFile()) {
      throw new ApiError(400, "invalid_path", "Path must point to a file");
    }
    const beforeUpdatedAt = before ? before.mtimeMs : null;
    if (!force && beforeUpdatedAt !== null && baseUpdatedAt !== null && beforeUpdatedAt !== baseUpdatedAt) {
      throw new ApiError(409, "conflict", "File changed since it was loaded", {
        baseUpdatedAt,
        currentUpdatedAt: beforeUpdatedAt,
      });
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "workspace.file.write",
      summary: `Write ${relativePath}`,
      paths: [absPath],
    });

    await ensureDir(dirname(absPath));
    const tmp = `${absPath}.tmp-${shortId()}`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, absPath);
    const after = await stat(absPath);
    const revision = fileRevision(after);

    recordWorkspaceFileEvent(workspace.id, {
      type: "write",
      path: relativePath,
      revision,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "workspace.file.write",
      target: absPath,
      summary: `Wrote ${relativePath}`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, path: relativePath, bytes, updatedAt: after.mtimeMs, revision });
  });

  addRoute(routes, "GET", "/workspace/:id/plugins", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const result = await listPlugins(workspace.path, includeGlobal);
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/plugins", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const spec = String(body.spec ?? "");
    const normalized = normalizePluginSpec(spec);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.add",
      summary: `Add plugin ${spec}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const changed = await addPlugin(workspace.path, spec);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.add",
      target: "opencode.json",
      summary: `Added ${spec}`,
      timestamp: Date.now(),
    });
    if (changed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: normalized,
        action: "added",
      });
    }
    const result = await listPlugins(workspace.path, false);
    return jsonResponse(result);
  });

  addRoute(routes, "DELETE", "/workspace/:id/plugins/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    const normalized = normalizePluginSpec(name);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.remove",
      summary: `Remove plugin ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const removed = await removePlugin(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.remove",
      target: "opencode.json",
      summary: `Removed ${name}`,
      timestamp: Date.now(),
    });
    if (removed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: normalized,
        action: "removed",
      });
    }
    const result = await listPlugins(workspace.path, false);
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/hub/skills", "client", async (ctx) => {
    const owner = ctx.url.searchParams.get("owner")?.trim();
    const repo = ctx.url.searchParams.get("repo")?.trim();
    const ref = ctx.url.searchParams.get("ref")?.trim();
    const items = await listHubSkills({
      owner: owner || "different-ai",
      repo: repo || "openwork-hub",
      ref: ref || "main",
    });
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/skills", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const items = await listSkills(workspace.path, includeGlobal);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/skills/hub/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const body = await readJsonBody(ctx.request);
    const overwrite = body?.overwrite === true;
    const repoPayload = body?.repo && typeof body.repo === "object" ? (body.repo as Record<string, unknown>) : undefined;
    const repo = repoPayload
      ? {
          owner: typeof repoPayload.owner === "string" ? repoPayload.owner : undefined,
          repo: typeof repoPayload.repo === "string" ? repoPayload.repo : undefined,
          ref: typeof repoPayload.ref === "string" ? repoPayload.ref : undefined,
        }
      : undefined;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.install_hub",
      summary: `Install hub skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name)],
    });

    const result = await installHubSkill(workspace.path, { name, overwrite, repo });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.install_hub",
      target: result.path,
      summary: `Installed hub skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: result.action,
      path: result.path,
    });

    return jsonResponse({ ok: true, ...result });
  });

  addRoute(routes, "GET", "/workspace/:id/skills/:name", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const items = await listSkills(workspace.path, includeGlobal);
    const item = items.find((skill) => skill.name === name);
    if (!item) {
      throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
    }
    const content = await readFile(item.path, "utf8");
    return jsonResponse({ item, content });
  });

  addRoute(routes, "POST", "/workspace/:id/skills", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const content = String(body.content ?? "");
    const description = body.description ? String(body.description) : undefined;
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.upsert",
      summary: `Upsert skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name, "SKILL.md")],
    });
    const result = await upsertSkill(workspace.path, { name, content, description });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.upsert",
      target: result.path,
      summary: `Upserted skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: result.action,
      path: result.path,
    });
    return jsonResponse({ name, path: result.path, description: description ?? "", scope: "project" });
  });

  addRoute(routes, "DELETE", "/workspace/:id/skills/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.delete",
      summary: `Delete skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name)],
    });
    const result = await deleteSkill(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.delete",
      target: result.path,
      summary: `Deleted skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: "removed",
      path: result.path,
    });
    return jsonResponse({ ok: true, name, path: result.path });
  });

  addRoute(routes, "GET", "/workspace/:id/mcp", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listMcp(workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/mcp", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const configPayload = body.config as Record<string, unknown> | undefined;
    if (!configPayload) {
      throw new ApiError(400, "invalid_payload", "MCP config is required");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.add",
      summary: `Add MCP ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const result = await addMcp(workspace.path, name, configPayload);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.add",
      target: "opencode.json",
      summary: `Added MCP ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
      type: "mcp",
      name,
      action: result.action,
    });
    const items = await listMcp(workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/mcp/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.remove",
      summary: `Remove MCP ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const removed = await removeMcp(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.remove",
      target: "opencode.json",
      summary: `Removed MCP ${name}`,
      timestamp: Date.now(),
    });
    if (removed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
        type: "mcp",
        name,
        action: "removed",
      });
    }
    const items = await listMcp(workspace.path);
    return jsonResponse({ items });
  });

  // Toggle `enabled` on a workspace MCP. Strict body validation — `Boolean(body.enabled)`
  // would silently disable on `{}` or coerce `"false"` to true.
  addRoute(routes, "POST", "/workspace/:id/mcp/:name/enabled", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    const body = await readJsonBody(ctx.request);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.enabled !== "boolean") {
      throw new ApiError(400, "invalid_payload", "enabled must be a boolean");
    }
    const enabled = body.enabled;
    const action = enabled ? "mcp.enable" : "mcp.disable";
    const summary = `${enabled ? "Enable" : "Disable"} MCP ${name}`;
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action,
      summary,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const updated = await setMcpEnabled(workspace.path, name, enabled);
    if (!updated) {
      throw new ApiError(404, "mcp_not_found", `MCP ${name} not found in workspace config`);
    }
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action,
      target: "opencode.json",
      summary: `${enabled ? "Enabled" : "Disabled"} MCP ${name}`,
      timestamp: Date.now(),
    });
    // ReloadTrigger.action only allows added/removed/updated, so toggle => "updated".
    emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
      type: "mcp",
      name,
      action: "updated",
    });
    const items = await listMcp(workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/mcp/:name/auth", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    validateMcpName(name);

    const authStorePath = join(homedir(), ".config", "opencode", "mcp-auth.json");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.auth.remove",
      summary: `Logout MCP ${name}`,
      paths: [authStorePath],
    });

    // Best-effort disconnect so any active connection is torn down.
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      unwrapOpencodeResult(await opencode.mcp.disconnect({ name }), `/mcp/${encodeURIComponent(name)}/disconnect`);
    } catch {
      // ignore
    }

    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      unwrapOpencodeResult(await opencode.mcp.auth.remove({ name }), `/mcp/${encodeURIComponent(name)}/auth`);
    } catch (error) {
      // Treat missing credentials as a successful logout (idempotent).
      if (
        error instanceof ApiError &&
        error.code === "opencode_request_failed" &&
        error.details &&
        typeof error.details === "object" &&
        "status" in (error.details as Record<string, unknown>) &&
        (error.details as { status?: unknown }).status === 404
      ) {
        // ok
      } else {
        throw error;
      }
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.auth.remove",
      target: authStorePath,
      summary: `Logged out MCP ${name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/commands", "client", async (ctx) => {
    const scope = ctx.url.searchParams.get("scope") === "global" ? "global" : "workspace";
    if (scope === "global") {
      await requireHost(ctx.request, config, tokens);
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listCommands(workspace.path, scope);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/commands", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const template = String(body.template ?? "");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.upsert",
      summary: `Upsert command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    const path = await upsertCommand(workspace.path, {
      name,
      description: body.description ? String(body.description) : undefined,
      template,
      agent: body.agent ? String(body.agent) : undefined,
      model: body.model ? String(body.model) : undefined,
      subtask: typeof body.subtask === "boolean" ? body.subtask : undefined,
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.upsert",
      target: path,
      summary: `Upserted command ${name}`,
      timestamp: Date.now(),
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "commands", {
      type: "command",
      name: sanitizeCommandName(name),
      action: "updated",
      path,
    });
    const items = await listCommands(workspace.path, "workspace");
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/commands/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.delete",
      summary: `Delete command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    await deleteCommand(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.delete",
      target: join(workspace.path, ".opencode", "commands"),
      summary: `Deleted command ${name}`,
      timestamp: Date.now(),
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "commands", {
      type: "command",
      name: sanitizeCommandName(name),
      action: "removed",
      path: join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`),
    });
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/export", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sensitiveMode = parseWorkspaceExportSensitiveMode(ctx.url.searchParams.get("sensitive"));
    const exportPayload = await exportWorkspace(workspace, { sensitiveMode });
    return jsonResponse(exportPayload);
  });

  addRoute(routes, "POST", "/workspace/:id/import/preview", "client", async (ctx) => {
    requireClientScope(ctx, "viewer");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const preview = await buildWorkspaceImportPreview(workspace.path, body);
    return jsonResponse(publicWorkspaceImportPreview(preview));
  });

  addRoute(routes, "POST", "/workspace/:id/import", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const expectedFingerprint = parseWorkspaceImportPreviewFingerprint(body);
    const preview = await buildWorkspaceImportPreview(workspace.path, body);
    if (expectedFingerprint && expectedFingerprint !== preview.fingerprint) {
      return jsonResponse(
        {
          ok: false,
          code: "workspace_import_preview_stale",
          message: "Workspace changed after this import was previewed. Review the latest preview before importing.",
          preview: publicWorkspaceImportPreview(preview),
        },
        409,
      );
    }
    const approvalPaths = workspaceImportPreviewApprovalPaths(preview);
    if (approvalPaths.length === 0) {
      return jsonResponse({ ok: true, preview: publicWorkspaceImportPreview(preview) });
    }
    if (!expectedFingerprint) {
      return jsonResponse(
        {
          ok: false,
          code: "workspace_import_preview_required",
          message: "Review this import preview before applying workspace changes.",
          preview: publicWorkspaceImportPreview(preview),
        },
        409,
      );
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.import",
      summary: summarizeWorkspaceImportPreview(preview),
      paths: approvalPaths,
    });
    const latestPreview = await buildWorkspaceImportPreview(workspace.path, body);
    if (latestPreview.fingerprint !== expectedFingerprint) {
      return jsonResponse(
        {
          ok: false,
          code: "workspace_import_preview_stale",
          message: "Workspace changed after this import was previewed. Review the latest preview before importing.",
          preview: publicWorkspaceImportPreview(latestPreview),
        },
        409,
      );
    }
    const configFingerprintBefore = await computeReloadFingerprint(workspace.path, "config");
    await importWorkspace(workspace, body, latestPreview);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.import",
      target: "workspace",
      summary: summarizeWorkspaceImportApplied(latestPreview),
      timestamp: Date.now(),
    });
    if (configFingerprintBefore !== await computeReloadFingerprint(workspace.path, "config")) {
      emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(opencodeConfigPath(workspace.path)));
    }
    return jsonResponse({ ok: true, preview: publicWorkspaceImportPreview(latestPreview) });
  });

  addRoute(routes, "POST", "/workspace/:id/blueprint/sessions/materialize", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const result = await materializeBlueprintSessions(config, workspace);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "blueprint.sessions.materialize",
      target: "workspace",
      summary: result.created.length
        ? `Materialized ${result.created.length} template starter session${result.created.length === 1 ? "" : "s"}`
        : "Checked template starter sessions",
      timestamp: Date.now(),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/approvals", "host", async (ctx) => {
    return jsonResponse({ items: ctx.approvals.list() });
  });

  addRoute(routes, "POST", "/approvals/:id", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const reply = body.reply === "allow" ? "allow" : "deny";
    const result = ctx.approvals.respond(ctx.params.id, reply);
    if (!result) {
      throw new ApiError(404, "approval_not_found", "Approval request not found");
    }
    return jsonResponse({ ok: true, allowed: result.allowed });
  });

  return routes;
}

function remapSessionReadError(error: unknown): never {
  if (error instanceof ApiError && error.code === "opencode_request_failed") {
    const details = error.details;
    const upstreamStatus =
      details && typeof details === "object" && "status" in details ? Number((details as { status?: unknown }).status) : NaN;
    if (upstreamStatus === 400) {
      throw new ApiError(400, "invalid_query", "OpenCode rejected the session read request", details);
    }
    if (upstreamStatus === 404) {
      throw new ApiError(404, "session_not_found", "Session not found", details);
    }
  }
  throw error;
}

async function listWorkspaceSessions(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  input: { roots?: boolean; start?: number; search?: string; limit?: number },
) {
  try {
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    return buildSessionList(
      unwrapOpencodeResult(
        await opencode.session.list({
          roots: input.roots,
          start: input.start,
          search: input.search,
          limit: input.limit,
        }),
        "/session",
      ),
    );
  } catch (error) {
    remapSessionReadError(error);
  }
}

async function readWorkspaceSession(config: ServerConfig, workspace: WorkspaceInfo, sessionId: string) {
  try {
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    return buildSession(
      unwrapOpencodeResult(
        await opencode.session.get({ sessionID: sessionId }),
        `/session/${encodeURIComponent(sessionId)}`,
      ),
    );
  } catch (error) {
    remapSessionReadError(error);
  }
}

async function readWorkspaceSessionMessages(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  sessionId: string,
  input: { limit?: number },
) {
  try {
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    return buildSessionMessages(
      unwrapOpencodeResult(
        await opencode.session.messages({ sessionID: sessionId, limit: input.limit }),
        `/session/${encodeURIComponent(sessionId)}/message`,
      ),
    );
  } catch (error) {
    remapSessionReadError(error);
  }
}

async function readWorkspaceSessionTodos(config: ServerConfig, workspace: WorkspaceInfo, sessionId: string) {
  try {
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    return buildSessionTodos(
      unwrapOpencodeResult(
        await opencode.session.todo({ sessionID: sessionId }),
        `/session/${encodeURIComponent(sessionId)}/todo`,
      ),
    );
  } catch (error) {
    remapSessionReadError(error);
  }
}

async function readWorkspaceSessionStatuses(config: ServerConfig, workspace: WorkspaceInfo) {
  try {
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    return buildSessionStatuses(
      unwrapOpencodeResult(await opencode.session.status(), "/session/status"),
    );
  } catch (error) {
    remapSessionReadError(error);
  }
}

async function readWorkspaceSessionSnapshot(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  sessionId: string,
  input: { limit?: number },
) {
  try {
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    const [session, messages, todos, statuses] = await Promise.all([
      opencode.session
        .get({ sessionID: sessionId })
        .then((result) => unwrapOpencodeResult(result, `/session/${encodeURIComponent(sessionId)}`)),
      opencode.session
        .messages({ sessionID: sessionId, limit: input.limit })
        .then((result) => unwrapOpencodeResult(result, `/session/${encodeURIComponent(sessionId)}/message`)),
      opencode.session
        .todo({ sessionID: sessionId })
        .then((result) => unwrapOpencodeResult(result, `/session/${encodeURIComponent(sessionId)}/todo`)),
      opencode.session.status().then((result) => unwrapOpencodeResult(result, "/session/status")),
    ]);
    return buildSessionSnapshot({ session, messages, todos, statuses });
  } catch (error) {
    remapSessionReadError(error);
  }
}

async function resolveWorkspace(config: ServerConfig, id: string): Promise<WorkspaceInfo> {
  const workspaceId = id.trim();
  const aliasWorkspaceId = workspaceId.startsWith("rem_") ? workspaceId.slice("rem_".length) : "";
  const workspace =
    config.workspaces.find((entry) => entry.id === workspaceId) ??
    (aliasWorkspaceId ? config.workspaces.find((entry) => entry.id === aliasWorkspaceId) : undefined);
  if (!workspace) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found");
  }
  const resolvedWorkspace = resolve(workspace.path);
  const authorized = await isAuthorizedRoot(resolvedWorkspace, config.authorizedRoots);
  if (!authorized) {
    throw new ApiError(403, "workspace_unauthorized", "Workspace is not authorized");
  }
  if (!config.readOnly) {
    const ensured = await ensureWorkspaceFiles(resolvedWorkspace, workspace.preset ?? "starter");
    const bootstrapReloadReasons = new Set<ReloadReason>(ensured.reloadReasons);
    if (await repairCommands(resolvedWorkspace)) {
      bootstrapReloadReasons.add("commands");
    }
    if (bootstrapReloadReasons.size > 0) {
      await reloadBaselineRefreshers.get(config)?.(workspace.id, Array.from(bootstrapReloadReasons));
      reloadOpencodeEngineAfterInternalBootstrap(config, { ...workspace, path: resolvedWorkspace });
    }
  }
  return { ...workspace, path: resolvedWorkspace };
}

function reloadOpencodeEngineAfterInternalBootstrap(config: ServerConfig, workspace: WorkspaceInfo): void {
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  if (!connection.baseUrl?.trim()) return;
  void reloadOpencodeEngine(config, workspace).catch(() => undefined);
}

async function isAuthorizedRoot(workspacePath: string, roots: string[]): Promise<boolean> {
  const resolvedWorkspace = resolve(workspacePath);
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    if (resolvedWorkspace === resolvedRoot) return true;
    if (resolvedWorkspace.startsWith(resolvedRoot + sep)) return true;
  }
  return false;
}

function ensureWritable(config: ServerConfig): void {
  if (config.readOnly) {
    throw new ApiError(403, "read_only", "Server is read-only");
  }
}

function scopeRank(scope: TokenScope): number {
  if (scope === "viewer") return 1;
  if (scope === "collaborator") return 2;
  return 3;
}

function requireClientScope(ctx: RequestContext, required: TokenScope): void {
  const scope = ctx.actor?.scope;
  if (!scope) {
    throw new ApiError(401, "unauthorized", "Missing token scope");
  }
  if (scopeRank(scope) < scopeRank(required)) {
    throw new ApiError(403, "forbidden", "Insufficient token scope", { required, scope });
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const json = await request.json();
    return json as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

function parseOptionalPositiveInteger(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ApiError(400, "invalid_query", `${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalNonNegativeInteger(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ApiError(400, "invalid_query", `${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptionalBoolean(value: string | null, name: string): boolean | undefined {
  if (value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ApiError(400, "invalid_query", `${name} must be a boolean`);
}

function ensurePlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

type OpenworkServerConfigFile = Record<string, unknown> & {
  workspaces?: Array<Record<string, unknown>>;
  authorizedRoots?: string[];
};

async function readServerConfigFile(configPath: string): Promise<OpenworkServerConfigFile> {
  if (!(await exists(configPath))) {
    return {};
  }

  try {
    const raw = await readFile(configPath, "utf8");
    return ensurePlainObject(JSON.parse(raw)) as OpenworkServerConfigFile;
  } catch (error) {
    throw new ApiError(422, "invalid_json", "Failed to parse server config", {
      path: configPath,
      error: String(error),
    });
  }
}

function serializeWorkspaceConfigEntry(workspace: WorkspaceInfo): Record<string, unknown> {
  return {
    id: workspace.id,
    path: workspace.path,
    name: workspace.name,
    preset: workspace.preset,
    workspaceType: workspace.workspaceType,
    ...(workspace.remoteType ? { remoteType: workspace.remoteType } : {}),
    ...(workspace.baseUrl ? { baseUrl: workspace.baseUrl } : {}),
    ...(workspace.directory ? { directory: workspace.directory } : {}),
    ...(workspace.displayName ? { displayName: workspace.displayName } : {}),
    ...(workspace.openworkHostUrl ? { openworkHostUrl: workspace.openworkHostUrl } : {}),
    ...(workspace.openworkToken ? { openworkToken: workspace.openworkToken } : {}),
    ...(workspace.openworkWorkspaceId ? { openworkWorkspaceId: workspace.openworkWorkspaceId } : {}),
    ...(workspace.openworkWorkspaceName ? { openworkWorkspaceName: workspace.openworkWorkspaceName } : {}),
    ...(workspace.sandboxBackend ? { sandboxBackend: workspace.sandboxBackend } : {}),
    ...(workspace.sandboxRunId ? { sandboxRunId: workspace.sandboxRunId } : {}),
    ...(workspace.sandboxContainerName ? { sandboxContainerName: workspace.sandboxContainerName } : {}),
    ...(workspace.opencodeUsername ? { opencodeUsername: workspace.opencodeUsername } : {}),
    ...(workspace.opencodePassword ? { opencodePassword: workspace.opencodePassword } : {}),
  };
}

async function persistServerWorkspaceState(config: ServerConfig): Promise<boolean> {
  const configPath = config.configPath?.trim() ?? "";
  if (!configPath) return false;
  if (!(await exists(configPath))) return false;

  const parsed = await readServerConfigFile(configPath);
  const next: OpenworkServerConfigFile = {
    ...parsed,
    workspaces: config.workspaces.map(serializeWorkspaceConfigEntry),
    authorizedRoots: Array.from(new Set(config.authorizedRoots.map((root) => resolve(root)))),
  };

  await ensureDir(dirname(configPath));
  const tmpPath = `${configPath}.tmp.${shortId()}`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, configPath);
    return true;
  } finally {
    try {
      await rm(tmpPath);
    } catch {
      // ignore
    }
  }
}

function normalizeOpencodeScope(value: string | null | undefined): "project" | "global" {
  return value?.trim().toLowerCase() === "global" ? "global" : "project";
}

function resolveOpencodeConfigFilePath(scope: "project" | "global", workspaceRoot: string): string {
  if (scope === "global") {
    const base = join(homedir(), ".config", "opencode");
    const jsoncPath = join(base, "opencode.jsonc");
    const jsonPath = join(base, "opencode.json");
    if (existsSync(jsoncPath)) return jsoncPath;
    if (existsSync(jsonPath)) return jsonPath;
    return jsoncPath;
  }
  return opencodeConfigPath(workspaceRoot);
}

function getRuntimeControlConfig(): { baseUrl: string; token: string } | null {
  const baseUrl = process.env.OPENWORK_CONTROL_BASE_URL?.trim() ?? "";
  const token = process.env.OPENWORK_CONTROL_TOKEN?.trim() ?? "";
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

async function fetchRuntimeControl(path: string, init?: { method?: string; body?: unknown }) {
  const control = getRuntimeControlConfig();
  if (!control) {
    throw new ApiError(501, "runtime_upgrade_unavailable", "Worker runtime control is not configured on this host");
  }
  const response = await fetch(`${control.baseUrl}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${control.token}`,
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new ApiError(response.status, "runtime_upgrade_failed", "Worker runtime control request failed", json);
  }
  return json;
}

async function readOpencodeConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  return data;
}

async function readOpenworkConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const path = openworkConfigPath(workspaceRoot);
  if (!(await exists(path))) return {};
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse openwork.json");
  }
}

function resolveOpencodeDirectory(workspace: WorkspaceInfo): string | null {
  const explicit = workspace.directory?.trim() ?? "";
  if (explicit) return normalizeOpencodeDirectory(explicit);
  if (workspace.workspaceType === "local") return normalizeOpencodeDirectory(workspace.path);
  return null;
}

function normalizeOpencodeDirectory(directory: string): string {
  // OpenCode stores/list-filters Windows sessions by regular drive paths
  // (`C:\Users\...`). Electron can persist local workspaces as extended-length
  // paths (`\\?\C:\Users\...`); passing those through as the directory query
  // makes OpenCode return an empty session list even though the sessions exist.
  if (process.platform === "win32") {
    return directory.replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "");
  }
  return directory;
}

function buildOpencodeReloadUrl(baseUrl: string, directory?: string | null): string {
  try {
    const url = new URL(baseUrl);
    url.pathname = "/instance/dispose";
    url.search = "";
    if (directory) {
      url.searchParams.set("directory", directory);
    }
    return url.toString();
  } catch {
    throw new ApiError(400, "opencode_url_invalid", "OpenCode base URL is invalid");
  }
}

function parseOpencodeErrorBody(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

async function reloadOpencodeEngine(config: ServerConfig, workspace: WorkspaceInfo): Promise<void> {
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  const baseUrl = connection.baseUrl?.trim() ?? "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const directory = resolveOpencodeDirectory(workspace);
  const targetUrl = buildOpencodeReloadUrl(baseUrl, directory);
  const headers: Record<string, string> = {};
  const auth = connection.authHeader ?? null;
  if (auth) headers.Authorization = auth;

  const response = await fetch(targetUrl, { method: "POST", headers });
  if (response.ok) return;
  const body = parseOpencodeErrorBody(await response.text());
  throw new ApiError(502, "opencode_reload_failed", "OpenCode reload failed", {
    status: response.status,
    body,
  });
}

async function writeOpenworkConfig(workspaceRoot: string, payload: Record<string, unknown>, merge: boolean): Promise<void> {
  const path = openworkConfigPath(workspaceRoot);
  const next = merge ? { ...(await readOpenworkConfig(workspaceRoot)), ...payload } : payload;
  await ensureDir(join(workspaceRoot, ".opencode"));
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
}

async function requireApproval(
  ctx: RequestContext,
  input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">,
): Promise<void> {
  const actor = ctx.actor ?? { type: "remote" };
  const result = await ctx.approvals.requestApproval({ ...input, actor });
  if (!result.allowed) {
    throw new ApiError(403, "write_denied", "Write request denied", {
      requestId: result.id,
      reason: result.reason,
    });
  }
}

async function exportWorkspace(
  workspace: WorkspaceInfo,
  options?: { sensitiveMode?: WorkspaceExportSensitiveMode },
) {
  const sensitiveMode = options?.sensitiveMode ?? "auto";
  const rawOpencode = await readOpencodeConfig(workspace.path);
  let opencode = sanitizePortableOpencodeConfig(rawOpencode);
  const openwork = sanitizeOpenworkTemplateConfig(await readOpenworkConfig(workspace.path));
  const skills = await listSkills(workspace.path, false);
  const commands = await listCommands(workspace.path, "workspace");
  let files = await listPortableFiles(workspace.path);
  const warnings = collectWorkspaceExportWarnings({ opencode: rawOpencode, files });
  if (warnings.length && sensitiveMode === "auto") {
    throw new ApiError(
      409,
      "workspace_export_requires_decision",
      "This workspace includes sensitive config. Choose whether to exclude it or include it before exporting.",
      { warnings },
    );
  }
  if (sensitiveMode === "exclude") {
    const sanitized = stripSensitiveWorkspaceExportData({ opencode, files });
    opencode = sanitized.opencode;
    files = sanitized.files;
  }
  const skillContents = await Promise.all(
    skills.map(async (skill) => ({
      name: skill.name,
      description: skill.description,
      content: await readFile(skill.path, "utf8"),
    })),
  );
  const commandContents = await Promise.all(
    commands.map(async (command) => ({
      name: command.name,
      description: command.description,
      template: command.template,
    })),
  );

  return {
    workspaceId: workspace.id,
    exportedAt: Date.now(),
    opencode,
    openwork,
    skills: skillContents,
    commands: commandContents,
    ...(files.length ? { files } : {}),
  };
}

function parseWorkspaceExportSensitiveMode(input: string | null): WorkspaceExportSensitiveMode {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "auto";
  if (trimmed === "auto" || trimmed === "include" || trimmed === "exclude") {
    return trimmed;
  }
  throw new ApiError(400, "invalid_workspace_export_sensitive_mode", `Invalid workspace export sensitive mode: ${trimmed}`);
}

function parseWorkspaceImportPreviewFingerprint(payload: Record<string, unknown>): string | null {
  const value = payload.previewFingerprint;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(
      400,
      "invalid_workspace_import_preview_fingerprint",
      "Workspace import preview fingerprint must be a string",
    );
  }
  return value;
}

function workspaceImportRelativePath(workspace: WorkspaceInfo, path: string): string {
  return relative(workspace.path, path).replaceAll("\\", "/");
}

async function importWorkspace(workspace: WorkspaceInfo, payload: Record<string, unknown>, preview: WorkspaceImportPlan): Promise<void> {
  const input = normalizeWorkspaceImportPayload(workspace.path, payload);
  const changed = new Set(
    preview.changes
      .filter((change) => change.action !== "unchanged")
      .map((change) => `${change.kind}:${change.path}`),
  );
  const changedPath = (kind: string, path: string) => changed.has(`${kind}:${path}`);

  if (
    input.opencode !== undefined &&
    changedPath("opencode", workspaceImportRelativePath(workspace, opencodeConfigPath(workspace.path)))
  ) {
    if (input.modes.opencode === "replace") {
      await writeJsoncFile(opencodeConfigPath(workspace.path), input.opencode);
    } else {
      await updateJsoncTopLevel(opencodeConfigPath(workspace.path), input.opencode);
    }
  }

  if (
    input.openwork !== undefined &&
    changedPath("openwork", workspaceImportRelativePath(workspace, openworkConfigPath(workspace.path)))
  ) {
    if (input.modes.openwork === "replace") {
      await writeOpenworkConfig(workspace.path, input.openwork, false);
    } else {
      await writeOpenworkConfig(workspace.path, input.openwork, true);
    }
  }

  if (input.sections.skills) {
    for (const skill of input.skills) {
      const path = workspaceImportRelativePath(workspace, join(projectSkillsDir(workspace.path), skill.name, "SKILL.md"));
      if (!changedPath("skill", path)) continue;
      await upsertSkill(workspace.path, skill);
    }
    if (input.modes.skills === "replace") {
      for (const change of preview.changes) {
        if (change.kind === "skill" && change.action === "delete") {
          await rm(change.absolutePath, { recursive: true, force: true });
        }
      }
    }
  }

  if (input.sections.commands) {
    for (const command of input.commands) {
      const path = workspaceImportRelativePath(workspace, join(projectCommandsDir(workspace.path), `${command.name}.md`));
      if (!changedPath("command", path)) continue;
      await upsertCommand(workspace.path, command);
    }
    if (input.modes.commands === "replace") {
      for (const change of preview.changes) {
        if (change.kind === "command" && change.action === "delete") {
          await rm(change.absolutePath, { force: true });
        }
      }
    }
  }

  if (input.sections.files) {
    for (const file of input.files) {
      if (!changedPath("file", file.path)) continue;
      const path = join(workspace.path, file.path);
      await ensureDir(dirname(path));
      await writeFile(path, file.content, "utf8");
    }
    if (input.modes.files === "replace") {
      for (const change of preview.changes) {
        if (change.kind === "file" && change.action === "delete") {
          await rm(change.absolutePath, { force: true });
        }
      }
    }
  }
}

async function materializeBlueprintSessions(config: ServerConfig, workspace: WorkspaceInfo): Promise<{
  ok: boolean;
  created: Array<{ templateId: string; sessionId: string; title: string }>;
  existing: Array<{ templateId: string; sessionId: string }>;
  openSessionId: string | null;
}> {
  const openwork = await readOpenworkConfig(workspace.path);
  const templates = normalizeBlueprintSessionTemplates(openwork);
  if (!templates.length) {
    return { ok: true, created: [], existing: [], openSessionId: null };
  }

  const existing = readMaterializedBlueprintSessions(openwork);
  if (existing.length > 0) {
    const preferredTemplate = templates.find((template) => template.openOnFirstLoad) ?? templates[0] ?? null;
    const openSessionId = preferredTemplate
      ? existing.find((item) => item.templateId === preferredTemplate.id)?.sessionId ?? existing[0]?.sessionId ?? null
      : existing[0]?.sessionId ?? null;
    return { ok: true, created: [], existing, openSessionId };
  }

  const created: Array<{ templateId: string; sessionId: string; title: string }> = [];
  const opencode = createWorkspaceOpencodeClient(config, workspace);
  for (const template of templates) {
    const result = unwrapOpencodeResult(await opencode.session.create({ title: template.title }), "/session");
    const sessionId =
      result && typeof result === "object" && "id" in result && typeof result.id === "string" ? result.id.trim() : "";
    if (!sessionId) {
      throw new ApiError(502, "opencode_failed", "OpenCode session did not return an id");
    }
    seedOpencodeSessionMessages({
      sessionId,
      workspaceRoot: resolveOpencodeDirectory(workspace) ?? workspace.path,
      messages: template.messages,
    });
    created.push({ templateId: template.id, sessionId, title: template.title });
  }

  const now = Date.now();
  const nextOpenwork = applyMaterializedBlueprintSessions(
    openwork,
    created.map(({ templateId, sessionId }) => ({ templateId, sessionId })),
    now,
  );
  await writeOpenworkConfig(workspace.path, nextOpenwork, false);

  const preferredTemplate = templates.find((template) => template.openOnFirstLoad) ?? templates[0] ?? null;
  const openSessionId = preferredTemplate
    ? created.find((item) => item.templateId === preferredTemplate.id)?.sessionId ?? created[0]?.sessionId ?? null
    : created[0]?.sessionId ?? null;

  return { ok: true, created, existing: [], openSessionId };
}
