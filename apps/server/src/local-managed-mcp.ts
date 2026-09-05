import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  OAuthError,
  RegistrationRejectedError,
  SdkHttpError,
} from "@modelcontextprotocol/client";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createEnterpriseMcpClient,
  EnterpriseMcpClientError,
  type EnterpriseMcpConnection,
  type EnterpriseMcpDiagnosticEvent,
  type EnterpriseMcpOAuthAuthorizationHandle,
  type EnterpriseMcpOAuthClientRegistration,
  type EnterpriseMcpOAuthCredential,
  type EnterpriseMcpOAuthPersistence,
  type EnterpriseMcpPersistenceContext,
  type EnterpriseMcpRequestPhase,
} from "@openwork/enterprise-mcp-client";
import { ApiError } from "./errors.js";
import { sanitizeDiagnosticString } from "./diagnostic-sanitizer.js";
import { runtimeStorageDir } from "./runtime-db.js";
import {
  readRuntimeOpencodeConfig,
  runtimeMcpMap,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { isRecord } from "./workspace-kv-store.js";
import {
  assertLocalManagedMcpUrl,
  createLocalManagedMcpGuardedFetch,
  LocalManagedMcpPrivateUrlError,
} from "./local-managed-mcp-url-guard.js";

type LocalManagedMcpStatus = "needs_auth" | "connecting" | "connected" | "reconnect_required";

type StoredAuthorization = {
  revision: string;
  expiresAt: number;
  codeVerifier: string;
  clientRegistrationRevision?: string;
};

type StoredLocalManagedMcpConnection = {
  id: string;
  workspaceId: string;
  name: string;
  serverUrl: string;
  enabled: boolean;
  oauth: {
    applicationType: "native" | "web";
    requestedScopes?: string[];
    authorizationServerIssuer?: string;
    clientId?: string;
    clientSecret?: string;
  };
  status: LocalManagedMcpStatus;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  clientRegistration?: EnterpriseMcpOAuthClientRegistration;
  credential?: EnterpriseMcpOAuthCredential;
  authorizations: Record<string, StoredAuthorization>;
  discovery?: OAuthDiscoveryState;
};

type LocalManagedMcpVault = {
  schemaVersion: 1;
  connections: Record<string, StoredLocalManagedMcpConnection>;
};

type VaultEnvelope = {
  schemaVersion: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
};

/** Plaintext, non-secret projection of one stored connection (vault file v2). */
type LocalManagedMcpIndexEntry = {
  id: string;
  workspaceId: string;
  name: string;
  serverUrl: string;
  enabled: boolean;
  oauth: {
    applicationType: "native" | "web";
    requestedScopes?: string[];
    authorizationServerIssuer?: string;
    clientId?: string;
  };
  status: LocalManagedMcpStatus;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  hasCredential: boolean;
};

export type LocalManagedMcpVaultRecovery = {
  at: number;
  reason: string;
  quarantinedTo: string;
};

/** Parsed on-disk vault file: v1 is a bare envelope, v2 adds the index. */
type VaultFileState = {
  envelope: VaultEnvelope;
  index: Record<string, LocalManagedMcpIndexEntry> | null;
  lastRecovery: LocalManagedMcpVaultRecovery | null;
};

type LoadedVault = {
  vault: LocalManagedMcpVault;
  lastRecovery: LocalManagedMcpVaultRecovery | null;
};

export type LocalManagedMcpPublicConnection = {
  name: string;
  serverUrl: string;
  enabled: boolean;
  status: LocalManagedMcpStatus;
  lastError: string | null;
  hasCredential: boolean;
  updatedAt: number;
};

export type CreateLocalManagedMcpInput = {
  workspaceId: string;
  name: string;
  serverUrl: string;
  oauth: {
    applicationType?: "native" | "web";
    requestedScopes?: string[];
    authorizationServerIssuer?: string;
    clientId?: string;
    clientSecret?: string;
  };
};

const VAULT_AAD = Buffer.from("openwork-local-managed-mcp-v1", "utf8");
const VAULT_RECOVERY_REASON = "secure_storage_changed";
const VAULT_RECOVERED_LAST_ERROR =
  "Secure storage on this device changed, so saved sign-ins were cleared. Reconnect to restore this connection.";
const MANAGED_MCP_CONNECTION_FAILED_MESSAGE =
  "OpenWork could not connect to this MCP server. Check its OAuth settings and availability, then try again.";
const EXTERNAL_HANDSHAKE_REQUEST_PHASES = new Set<EnterpriseMcpRequestPhase>([
  "oauth-client-registration",
  "mcp-discovery",
  "mcp-initialize",
]);
const vaultQueueByPath = new Map<string, Promise<void>>();
const vaultKeyByConfig = new WeakMap<ServerConfig, Promise<Buffer>>();
const gatewaySecretByConfig = new WeakMap<ServerConfig, Buffer>();
const guardedFetch = createLocalManagedMcpGuardedFetch();

function emptyVault(): LocalManagedMcpVault {
  return { schemaVersion: 1, connections: {} };
}

function vaultPath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "local-managed-mcp-vault.json");
}

function secureVaultStorageUnavailable(): ApiError {
  return new ApiError(
    503,
    "managed_mcp_secure_storage_unavailable",
    "Secure storage for OpenWork-managed MCP credentials is unavailable. Start through OpenWork Desktop or set OPENWORK_ENCRYPTION_KEY.",
  );
}

async function resolveVaultKey(config: ServerConfig): Promise<Buffer> {
  if (config.localManagedMcpVaultKey) {
    try {
      const key = Buffer.from(await config.localManagedMcpVaultKey());
      if (key.byteLength !== 32) throw new Error("invalid vault key length");
      return key;
    } catch {
      throw secureVaultStorageUnavailable();
    }
  }
  const configured = process.env.OPENWORK_ENCRYPTION_KEY?.trim();
  if (configured) return createHash("sha256").update(configured).digest();
  throw secureVaultStorageUnavailable();
}

async function vaultKey(config: ServerConfig): Promise<Buffer> {
  let pending = vaultKeyByConfig.get(config);
  if (!pending) {
    pending = resolveVaultKey(config);
    vaultKeyByConfig.set(config, pending);
  }
  try {
    return Buffer.from(await pending);
  } catch (error) {
    vaultKeyByConfig.delete(config);
    throw error;
  }
}

function isVaultEnvelope(value: unknown): value is VaultEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && record.algorithm === "aes-256-gcm"
    && typeof record.iv === "string"
    && typeof record.tag === "string"
    && typeof record.data === "string";
}

function isVault(value: unknown): value is LocalManagedMcpVault {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && typeof record.connections === "object"
    && record.connections !== null
    && !Array.isArray(record.connections);
}

function isConnectionStatus(value: unknown): value is LocalManagedMcpStatus {
  return value === "needs_auth" || value === "connecting" || value === "connected" || value === "reconnect_required";
}

function isVaultIndexEntry(value: unknown): value is LocalManagedMcpIndexEntry {
  if (!isRecord(value) || !isRecord(value.oauth)) return false;
  const oauth = value.oauth;
  return typeof value.id === "string"
    && typeof value.workspaceId === "string"
    && typeof value.name === "string"
    && typeof value.serverUrl === "string"
    && typeof value.enabled === "boolean"
    && (oauth.applicationType === "native" || oauth.applicationType === "web")
    && (oauth.requestedScopes === undefined
      || (Array.isArray(oauth.requestedScopes) && oauth.requestedScopes.every((scope) => typeof scope === "string")))
    && (oauth.authorizationServerIssuer === undefined || typeof oauth.authorizationServerIssuer === "string")
    && (oauth.clientId === undefined || typeof oauth.clientId === "string")
    && isConnectionStatus(value.status)
    && (value.lastError === undefined || typeof value.lastError === "string")
    && typeof value.createdAt === "number"
    && typeof value.updatedAt === "number"
    && typeof value.hasCredential === "boolean";
}

function isVaultRecovery(value: unknown): value is LocalManagedMcpVaultRecovery {
  return isRecord(value)
    && typeof value.at === "number"
    && typeof value.reason === "string"
    && typeof value.quarantinedTo === "string";
}

function readVaultIndex(value: unknown): Record<string, LocalManagedMcpIndexEntry> {
  if (!isRecord(value)) return {};
  const index: Record<string, LocalManagedMcpIndexEntry> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isVaultIndexEntry(entry)) index[key] = entry;
  }
  return index;
}

/** Parse the vault file without decrypting. Accepts v1 (bare envelope) and v2. */
async function readVaultFileState(config: ServerConfig): Promise<VaultFileState | null> {
  let raw: string;
  try {
    raw = await readFile(vaultPath(config), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (isVaultEnvelope(value)) return { envelope: value, index: null, lastRecovery: null };
  if (isRecord(value) && value.schemaVersion === 2 && isVaultEnvelope(value.vault)) {
    return {
      envelope: value.vault,
      index: readVaultIndex(value.index),
      lastRecovery: isVaultRecovery(value.lastRecovery) ? value.lastRecovery : null,
    };
  }
  throw new Error("The local managed MCP vault envelope is invalid.");
}

function decryptVault(envelope: VaultEnvelope, key: Buffer): LocalManagedMcpVault {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(VAULT_AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const value: unknown = JSON.parse(plaintext);
  if (!isVault(value)) throw new Error("The local managed MCP vault payload is invalid.");
  return value;
}

function vaultIndexEntry(connection: StoredLocalManagedMcpConnection): LocalManagedMcpIndexEntry {
  return {
    id: connection.id,
    workspaceId: connection.workspaceId,
    name: connection.name,
    serverUrl: connection.serverUrl,
    enabled: connection.enabled,
    oauth: {
      applicationType: connection.oauth.applicationType,
      ...(connection.oauth.requestedScopes ? { requestedScopes: connection.oauth.requestedScopes } : {}),
      ...(connection.oauth.authorizationServerIssuer ? { authorizationServerIssuer: connection.oauth.authorizationServerIssuer } : {}),
      ...(connection.oauth.clientId ? { clientId: connection.oauth.clientId } : {}),
    },
    status: connection.status,
    ...(connection.lastError === undefined ? {} : { lastError: connection.lastError }),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    hasCredential: Boolean(connection.credential),
  };
}

async function writeVault(
  config: ServerConfig,
  vault: LocalManagedMcpVault,
  lastRecovery: LocalManagedMcpVaultRecovery | null,
): Promise<void> {
  const path = vaultPath(config);
  const key = await vaultKey(config);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(VAULT_AAD);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(vault), "utf8"), cipher.final()]);
  const envelope: VaultEnvelope = {
    schemaVersion: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
  const file = {
    schemaVersion: 2,
    index: Object.fromEntries(
      Object.entries(vault.connections).map(([entryKey, connection]) => [entryKey, vaultIndexEntry(connection)]),
    ),
    vault: envelope,
    ...(lastRecovery ? { lastRecovery } : {}),
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(file)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function withVaultQueue<T>(config: ServerConfig, run: () => Promise<T>): Promise<T> {
  const path = vaultPath(config);
  const previous = vaultQueueByPath.get(path) ?? Promise.resolve();
  let resolveCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  vaultQueueByPath.set(path, previous.catch(() => undefined).then(() => current));
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    resolveCurrent?.();
  }
}

function rebuiltConnection(entry: LocalManagedMcpIndexEntry): StoredLocalManagedMcpConnection {
  return {
    id: entry.id,
    workspaceId: entry.workspaceId,
    name: entry.name,
    serverUrl: entry.serverUrl,
    enabled: entry.enabled,
    oauth: {
      applicationType: entry.oauth.applicationType,
      ...(entry.oauth.requestedScopes ? { requestedScopes: entry.oauth.requestedScopes } : {}),
      ...(entry.oauth.authorizationServerIssuer ? { authorizationServerIssuer: entry.oauth.authorizationServerIssuer } : {}),
      ...(entry.oauth.clientId ? { clientId: entry.oauth.clientId } : {}),
    },
    status: "reconnect_required",
    lastError: VAULT_RECOVERED_LAST_ERROR,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    authorizations: {},
  };
}

function isManagedGatewayRuntimeEntry(entry: Record<string, unknown>): boolean {
  return entry.type === "remote"
    && entry.oauth === false
    && typeof entry.url === "string"
    && entry.url.includes("/mcp/managed/");
}

/** Best effort: drop managed gateway runtime entries that lost their vault connection. */
async function pruneOrphanedManagedRuntimeEntries(config: ServerConfig, vault: LocalManagedMcpVault): Promise<void> {
  for (const workspace of config.workspaces) {
    try {
      const mcp = runtimeMcpMap(await readRuntimeOpencodeConfig(config, workspace.id));
      for (const [name, entry] of Object.entries(mcp)) {
        if (!isManagedGatewayRuntimeEntry(entry)) continue;
        if (vault.connections[connectionKey(workspace.id, name)]) continue;
        await removeManagedRuntimeEntry(config, workspace.id, name);
      }
    } catch (error) {
      console.warn(
        `[managed-mcp] Failed to prune managed runtime entries for workspace ${workspace.id} after vault recovery: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * The key resolved but the stored envelope no longer authenticates: OS secure
 * storage changed underneath the vault. Quarantine the unreadable file and
 * rebuild the vault from the plaintext index (v2) or empty (v1) so members can
 * reconnect instead of hitting raw crypto errors.
 */
function backupTimestamp(date: Date): string {
  const parts = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ];
  return parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0")).join("");
}

async function recoverVaultLocked(config: ServerConfig, file: VaultFileState): Promise<LoadedVault> {
  const path = vaultPath(config);
  const backupName = `${basename(path)}.openwork-backup-${backupTimestamp(new Date())}`;
  await rename(path, join(dirname(path), backupName));
  const vault = emptyVault();
  for (const [key, entry] of Object.entries(file.index ?? {})) {
    vault.connections[key] = rebuiltConnection(entry);
  }
  const lastRecovery: LocalManagedMcpVaultRecovery = {
    at: Date.now(),
    reason: VAULT_RECOVERY_REASON,
    quarantinedTo: backupName,
  };
  await writeVault(config, vault, lastRecovery);
  if (!file.index) await pruneOrphanedManagedRuntimeEntries(config, vault);
  return { vault, lastRecovery };
}

/** Only call while holding the per-path vault queue: may quarantine and rewrite. */
async function loadVaultLocked(config: ServerConfig): Promise<LoadedVault> {
  const file = await readVaultFileState(config);
  if (!file) return { vault: emptyVault(), lastRecovery: null };
  const key = await vaultKey(config);
  try {
    return { vault: decryptVault(file.envelope, key), lastRecovery: file.lastRecovery };
  } catch {
    return recoverVaultLocked(config, file);
  }
}

async function withVaultMutation<T>(
  config: ServerConfig,
  mutate: (vault: LocalManagedMcpVault) => Promise<T> | T,
  shouldPersist: (result: T) => boolean = () => true,
): Promise<T> {
  return withVaultQueue(config, async () => {
    const { vault, lastRecovery } = await loadVaultLocked(config);
    const result = await mutate(vault);
    if (shouldPersist(result)) await writeVault(config, vault, lastRecovery);
    return result;
  });
}

async function withVaultRead<T>(config: ServerConfig, read: (vault: LocalManagedMcpVault) => T): Promise<T> {
  return withVaultQueue(config, async () => read((await loadVaultLocked(config)).vault));
}

function connectionKey(workspaceId: string, name: string): string {
  return `${workspaceId.length}:${workspaceId}${name}`;
}

function requireConnection(vault: LocalManagedMcpVault, workspaceId: string, name: string): StoredLocalManagedMcpConnection {
  const connection = vault.connections[connectionKey(workspaceId, name)];
  if (!connection) throw new ApiError(404, "managed_mcp_not_found", `Managed MCP ${name} was not found`);
  return connection;
}

function publicConnection(connection: StoredLocalManagedMcpConnection): LocalManagedMcpPublicConnection {
  return {
    name: connection.name,
    serverUrl: connection.serverUrl,
    enabled: connection.enabled,
    status: connection.status,
    lastError: connection.lastError ?? null,
    hasCredential: Boolean(connection.credential),
    updatedAt: connection.updatedAt,
  };
}

function authorizationStorageKey(key: Buffer, authorizationId: string): string {
  return createHmac("sha256", key).update(authorizationId).digest("base64url");
}

function ensurePersistenceContext(context: EnterpriseMcpPersistenceContext): void {
  if (context.signal.aborted || Date.now() >= context.commitExpiresAt) {
    throw new Error("The managed MCP persistence deadline expired.");
  }
}

function createPersistence(config: ServerConfig, workspaceId: string, name: string): EnterpriseMcpOAuthPersistence {
  const loadConnection = () => withVaultRead(config, (vault) => requireConnection(vault, workspaceId, name));
  return {
    clientRegistrations: {
      load: async (context) => {
        ensurePersistenceContext(context);
        const connection = await loadConnection();
        if (connection.oauth.clientId) {
          const clientInformation: OAuthClientInformationMixed = {
            client_id: connection.oauth.clientId,
            ...(connection.oauth.clientSecret ? { client_secret: connection.oauth.clientSecret } : {}),
            token_endpoint_auth_method: connection.oauth.clientSecret ? "client_secret_post" : "none",
          };
          return { clientInformation, revision: "pre-registered:1", source: "pre-registered" };
        }
        return connection.clientRegistration;
      },
      save: async ({ context, clientInformation, expiresAt, source }) => {
        ensurePersistenceContext(context);
        return withVaultMutation(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          if (connection.clientRegistration) return connection.clientRegistration;
          const registration: EnterpriseMcpOAuthClientRegistration = {
            clientInformation,
            revision: randomUUID(),
            source,
            ...(expiresAt === undefined ? {} : { expiresAt }),
          };
          connection.clientRegistration = registration;
          connection.updatedAt = Date.now();
          return registration;
        });
      },
      invalidate: async ({ context }) => {
        ensurePersistenceContext(context);
        await withVaultMutation(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          delete connection.clientRegistration;
          connection.updatedAt = Date.now();
        });
      },
    },
    credentials: {
      load: async (context) => {
        ensurePersistenceContext(context);
        return (await loadConnection()).credential;
      },
      save: async ({ context, tokens, expiresAt, source, authorization, clientRegistrationRevision, expectedCredentialRevision }) => {
        ensurePersistenceContext(context);
        await withVaultMutation(config, async (vault) => {
          ensurePersistenceContext(context);
          const connection = requireConnection(vault, workspaceId, name);
          if (source === "refresh" && expectedCredentialRevision !== connection.credential?.revision) {
            throw new Error("The managed MCP credential changed during refresh.");
          }
          if (source === "authorization-code") {
            if (!authorization) throw new Error("The managed MCP authorization transaction is missing.");
            const key = await vaultKey(config);
            const storedKey = authorizationStorageKey(key, authorization.id);
            const stored = connection.authorizations[storedKey];
            if (!stored || stored.revision !== authorization.revision) {
              throw new Error("The managed MCP authorization transaction was already consumed.");
            }
            if (stored.clientRegistrationRevision !== clientRegistrationRevision) {
              throw new Error("The managed MCP OAuth client changed during authorization.");
            }
            delete connection.authorizations[storedKey];
          }
          connection.credential = {
            tokens,
            revision: randomUUID(),
            ...(expiresAt === undefined ? {} : { expiresAt }),
          };
          connection.status = "connected";
          delete connection.lastError;
          connection.updatedAt = Date.now();
        });
      },
      invalidate: async ({ context }) => {
        ensurePersistenceContext(context);
        await withVaultMutation(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          delete connection.credential;
          connection.status = "reconnect_required";
          connection.updatedAt = Date.now();
        });
      },
    },
    authorizations: {
      begin: async ({ context, id, codeVerifier, expiresAt, clientRegistrationRevision }) => {
        ensurePersistenceContext(context);
        const key = await vaultKey(config);
        await withVaultMutation(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          connection.authorizations[authorizationStorageKey(key, id)] = {
            revision: randomUUID(),
            expiresAt,
            codeVerifier,
            ...(clientRegistrationRevision === undefined ? {} : { clientRegistrationRevision }),
          };
          connection.updatedAt = Date.now();
        });
      },
      load: async ({ context, id }) => {
        ensurePersistenceContext(context);
        const key = await vaultKey(config);
        const stored = await withVaultRead(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          return connection.authorizations[authorizationStorageKey(key, id)];
        });
        if (!stored) return undefined;
        const handle: EnterpriseMcpOAuthAuthorizationHandle = {
          id,
          revision: stored.revision,
          expiresAt: stored.expiresAt,
          ...(stored.clientRegistrationRevision === undefined ? {} : { clientRegistrationRevision: stored.clientRegistrationRevision }),
        };
        return { handle, codeVerifier: stored.codeVerifier };
      },
      invalidate: async ({ context, id }) => {
        ensurePersistenceContext(context);
        const key = await vaultKey(config);
        await withVaultMutation(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          delete connection.authorizations[authorizationStorageKey(key, id)];
          connection.updatedAt = Date.now();
        });
      },
    },
    discovery: {
      load: async (context) => {
        ensurePersistenceContext(context);
        return (await loadConnection()).discovery;
      },
      save: async ({ context, state }) => {
        ensurePersistenceContext(context);
        await withVaultMutation(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          connection.discovery = state;
          connection.updatedAt = Date.now();
        });
      },
      invalidate: async ({ context }) => {
        ensurePersistenceContext(context);
        await withVaultMutation(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          delete connection.discovery;
          connection.updatedAt = Date.now();
        });
      },
    },
  };
}

async function enterpriseConnection(config: ServerConfig, workspaceId: string, name: string): Promise<EnterpriseMcpConnection> {
  const connection = await withVaultRead(config, (vault) => requireConnection(vault, workspaceId, name));
  return {
    id: connection.id,
    serverUrl: connection.serverUrl,
    authorization: {
      type: "oauth",
      persistence: createPersistence(config, workspaceId, name),
      configuration: {
        applicationType: connection.oauth.applicationType,
        ...(connection.oauth.requestedScopes ? { requestedScopes: connection.oauth.requestedScopes } : {}),
        ...(connection.oauth.authorizationServerIssuer ? { authorizationServerIssuer: connection.oauth.authorizationServerIssuer } : {}),
      },
    },
  };
}

function enterpriseClient(diagnostics?: EnterpriseMcpDiagnosticEvent[]) {
  return createEnterpriseMcpClient({
    fetch: guardedFetch,
    clientName: "OpenWork Local MCP Gateway",
    clientVersion: "1.0.0",
    operationTimeoutMs: 45_000,
    ...(diagnostics ? { diagnosticSink: (event) => diagnostics.push(event) } : {}),
  });
}

function serverOrigin(config: ServerConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

export function localManagedMcpCallbackUrl(config: ServerConfig): string {
  return `${serverOrigin(config)}/mcp/oauth/callback`;
}

function gatewaySecret(config: ServerConfig): Buffer {
  const existing = gatewaySecretByConfig.get(config);
  if (existing) return existing;
  const secret = randomBytes(32);
  gatewaySecretByConfig.set(config, secret);
  return secret;
}

function gatewayToken(config: ServerConfig, workspaceId: string, name: string): string {
  return createHmac("sha256", gatewaySecret(config)).update(`${workspaceId}\0${name}`).digest("base64url");
}

function gatewayPath(workspaceId: string, name: string): string {
  return `/mcp/managed/${encodeURIComponent(workspaceId)}/${encodeURIComponent(name)}`;
}

function runtimeConfig(config: ServerConfig, workspaceId: string, name: string, enabled: boolean): Record<string, unknown> {
  return {
    type: "remote",
    url: `${serverOrigin(config)}${gatewayPath(workspaceId, name)}`,
    enabled,
    headers: { Authorization: `Bearer ${gatewayToken(config, workspaceId, name)}` },
    oauth: false,
  };
}

async function writeManagedRuntimeEntry(config: ServerConfig, workspaceId: string, name: string, enabled: boolean): Promise<void> {
  await writeRuntimeOpencodeConfig(config, workspaceId, (current) => ({
    ...current,
    mcp: { ...runtimeMcpMap(current), [name]: runtimeConfig(config, workspaceId, name, enabled) },
  }));
}

async function removeManagedRuntimeEntry(config: ServerConfig, workspaceId: string, name: string): Promise<void> {
  await writeRuntimeOpencodeConfig(config, workspaceId, (current) => {
    const mcp = { ...runtimeMcpMap(current) };
    delete mcp[name];
    return { ...current, mcp };
  });
}

export async function reconcileLocalManagedMcpRuntimeEntries(config: ServerConfig): Promise<void> {
  const connections = await withVaultRead(config, (vault) => Object.values(vault.connections));
  for (const connection of connections) {
    if (!config.workspaces.some((workspace) => workspace.id === connection.workspaceId)) continue;
    await writeManagedRuntimeEntry(config, connection.workspaceId, connection.name, connection.enabled);
  }
}

export async function createLocalManagedMcpConnection(config: ServerConfig, input: CreateLocalManagedMcpInput): Promise<LocalManagedMcpPublicConnection> {
  let serverUrl: string;
  try {
    serverUrl = new URL(input.serverUrl).toString();
  } catch {
    throw new ApiError(400, "managed_mcp_url_invalid", `Managed MCP server URL "${input.serverUrl}" is invalid.`);
  }
  try {
    await assertLocalManagedMcpUrl(serverUrl);
  } catch (error) {
    if (!(error instanceof LocalManagedMcpPrivateUrlError)) throw error;
    const message = error.message.includes("managed MCP egress requires HTTPS")
      ? `OpenWork-managed sign-in requires an HTTPS server URL. ${error.message}`
      : error.message;
    throw new ApiError(400, "managed_mcp_url_not_allowed", message);
  }
  const now = Date.now();
  const connection = await withVaultMutation(config, (vault) => {
    const key = connectionKey(input.workspaceId, input.name);
    if (vault.connections[key]) {
      throw new ApiError(409, "managed_mcp_exists", `Managed MCP ${input.name} already exists`);
    }
    const stored: StoredLocalManagedMcpConnection = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name,
      serverUrl,
      enabled: true,
      oauth: {
        applicationType: input.oauth.applicationType ?? "native",
        ...(input.oauth.requestedScopes?.length ? { requestedScopes: [...new Set(input.oauth.requestedScopes)] } : {}),
        ...(input.oauth.authorizationServerIssuer ? { authorizationServerIssuer: input.oauth.authorizationServerIssuer } : {}),
        ...(input.oauth.clientId ? { clientId: input.oauth.clientId } : {}),
        ...(input.oauth.clientSecret ? { clientSecret: input.oauth.clientSecret } : {}),
      },
      status: "needs_auth",
      createdAt: now,
      updatedAt: now,
      authorizations: {},
    };
    vault.connections[key] = stored;
    return stored;
  });
  await writeManagedRuntimeEntry(config, input.workspaceId, input.name, true);
  return publicConnection(connection);
}

function sortByName(connections: LocalManagedMcpPublicConnection[]): LocalManagedMcpPublicConnection[] {
  return connections.sort((left, right) => left.name.localeCompare(right.name));
}

function indexPublicConnection(entry: LocalManagedMcpIndexEntry): LocalManagedMcpPublicConnection {
  return {
    name: entry.name,
    serverUrl: entry.serverUrl,
    enabled: entry.enabled,
    status: entry.status,
    lastError: entry.lastError ?? null,
    hasCredential: entry.hasCredential,
    updatedAt: entry.updatedAt,
  };
}

function isSecureStorageUnavailableError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "managed_mcp_secure_storage_unavailable";
}

export type LocalManagedMcpSafeConnectionList = {
  connections: LocalManagedMcpPublicConnection[];
  available: boolean;
  recovery: LocalManagedMcpVaultRecovery | null;
};

/**
 * Listing that never throws for secure-storage key or decrypt causes: a stale
 * key triggers quarantine-and-rebuild, and an unavailable key serves the
 * plaintext non-secret index read-only with `available: false`.
 */
export async function listLocalManagedMcpConnectionsSafe(
  config: ServerConfig,
  workspaceId: string,
): Promise<LocalManagedMcpSafeConnectionList> {
  return withVaultQueue(config, async () => {
    try {
      const { vault, lastRecovery } = await loadVaultLocked(config);
      return {
        connections: sortByName(Object.values(vault.connections)
          .filter((connection) => connection.workspaceId === workspaceId)
          .map(publicConnection)),
        available: true,
        recovery: lastRecovery,
      };
    } catch (error) {
      if (!isSecureStorageUnavailableError(error)) throw error;
      const file = await readVaultFileState(config).catch(() => null);
      return {
        connections: sortByName(Object.values(file?.index ?? {})
          .filter((entry) => entry.workspaceId === workspaceId)
          .map(indexPublicConnection)),
        available: false,
        recovery: file?.lastRecovery ?? null,
      };
    }
  });
}

export type LocalManagedMcpVaultInspection = {
  status: "absent" | "ok" | "recovered" | "secure-storage-unavailable" | "unreadable";
  recovery: LocalManagedMcpVaultRecovery | null;
};

/**
 * Passive vault visibility for diagnostics: reads only plaintext non-secret
 * fields plus key availability, never decrypts, and never throws.
 */
export async function inspectLocalManagedMcpVault(config: ServerConfig): Promise<LocalManagedMcpVaultInspection> {
  let file: VaultFileState | null;
  try {
    file = await readVaultFileState(config);
  } catch {
    return { status: "unreadable", recovery: null };
  }
  if (!file) return { status: "absent", recovery: null };
  const keyAvailable = await vaultKey(config).then(() => true, () => false);
  if (!keyAvailable) return { status: "secure-storage-unavailable", recovery: file.lastRecovery };
  return file.lastRecovery
    ? { status: "recovered", recovery: file.lastRecovery }
    : { status: "ok", recovery: null };
}

export async function getLocalManagedMcpConnection(config: ServerConfig, workspaceId: string, name: string): Promise<LocalManagedMcpPublicConnection> {
  return withVaultRead(config, (vault) => publicConnection(requireConnection(vault, workspaceId, name)));
}

type AuthorizationStatePayload = {
  version: 1;
  workspaceId: string;
  name: string;
  connectionId: string;
  redirectUri: string;
  expiresAt: number;
  nonce: string;
};

function encodeStatePayload(payload: AuthorizationStatePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

async function createAuthorizationState(config: ServerConfig, workspaceId: string, name: string): Promise<string> {
  const connection = await withVaultRead(config, (vault) => requireConnection(vault, workspaceId, name));
  const encoded = encodeStatePayload({
    version: 1,
    workspaceId,
    name,
    connectionId: connection.id,
    redirectUri: localManagedMcpCallbackUrl(config),
    expiresAt: Date.now() + 10 * 60_000,
    nonce: randomBytes(24).toString("base64url"),
  });
  const signature = createHmac("sha256", await vaultKey(config)).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function verifyAuthorizationState(config: ServerConfig, state: string): Promise<AuthorizationStatePayload> {
  const [encoded, signature, extra] = state.split(".");
  if (!encoded || !signature || extra) throw new ApiError(400, "managed_mcp_oauth_state_invalid", "OAuth state is invalid");
  const expected = createHmac("sha256", await vaultKey(config)).update(encoded).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    throw new ApiError(400, "managed_mcp_oauth_state_invalid", "OAuth state is invalid");
  }
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) {
    throw new ApiError(400, "managed_mcp_oauth_state_invalid", "OAuth state is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new ApiError(400, "managed_mcp_oauth_state_invalid", "OAuth state is invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "managed_mcp_oauth_state_invalid", "OAuth state is invalid");
  }
  const payload = value as Partial<AuthorizationStatePayload>;
  if (payload.version !== 1
    || typeof payload.workspaceId !== "string"
    || typeof payload.name !== "string"
    || typeof payload.connectionId !== "string"
    || typeof payload.redirectUri !== "string"
    || typeof payload.expiresAt !== "number"
    || typeof payload.nonce !== "string"
    || payload.expiresAt <= Date.now()) {
    throw new ApiError(400, "managed_mcp_oauth_state_invalid", "OAuth state is invalid or expired");
  }
  const connection = await withVaultRead(config, (vault) => requireConnection(vault, payload.workspaceId!, payload.name!));
  if (connection.id !== payload.connectionId || payload.redirectUri !== localManagedMcpCallbackUrl(config)) {
    throw new ApiError(400, "managed_mcp_oauth_state_invalid", "OAuth state does not match this connection");
  }
  return payload as AuthorizationStatePayload;
}

async function updateConnectionStatus(
  config: ServerConfig,
  workspaceId: string,
  name: string,
  status: LocalManagedMcpStatus,
  lastError?: string,
): Promise<void> {
  await withVaultMutation(config, (vault) => {
    const connection = requireConnection(vault, workspaceId, name);
    connection.status = status;
    connection.updatedAt = Date.now();
    if (lastError) {
      connection.lastError = sanitizeDiagnosticString(lastError)
        .replace(/([?&](?:access_token|refresh_token|client_secret|code|state)=)[^&\s]+/gi, "$1[REDACTED]")
        .replace(/("(?:access_token|refresh_token|client_secret|code|state)"\s*:\s*")[^"]+/gi, "$1[REDACTED]")
        .slice(0, 500);
    }
    else delete connection.lastError;
  });
}

type CompletedRequestDiagnostic = {
  requestPhase: EnterpriseMcpRequestPhase;
  outcome: "succeeded" | "failed";
  httpStatus?: number;
};

const NETWORK_FAILURE_CODES = new Set([
  "ConnectionRefused",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

function lastHandshakeRequestDiagnostic(
  diagnostics: EnterpriseMcpDiagnosticEvent[],
): CompletedRequestDiagnostic | null {
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    const event = diagnostics[index];
    if (!event
      || event.kind !== "request"
      || event.outcome === "started"
      || event.requestPhase === null
      || !EXTERNAL_HANDSHAKE_REQUEST_PHASES.has(event.requestPhase)) {
      continue;
    }
    return {
      requestPhase: event.requestPhase,
      outcome: event.outcome,
      ...(event.httpStatus === undefined ? {} : { httpStatus: event.httpStatus }),
    };
  }
  return null;
}

function errorCauseChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null && !seen.has(current); depth += 1) {
    chain.push(current);
    seen.add(current);
    current = isRecord(current)
      ? current.cause ?? (isRecord(current.data) ? current.data.cause : undefined)
      : undefined;
  }
  return chain;
}

function hasConcreteRequestCause(error: EnterpriseMcpClientError, diagnostic: CompletedRequestDiagnostic): boolean {
  const chain = errorCauseChain(error.cause);
  if (diagnostic.httpStatus !== undefined) {
    return diagnostic.httpStatus >= 400
      && diagnostic.httpStatus <= 599
      && chain.some((cause) => cause instanceof OAuthError
        || cause instanceof RegistrationRejectedError
        || cause instanceof SdkHttpError);
  }
  return chain.some((cause) => cause instanceof LocalManagedMcpPrivateUrlError
    || (cause instanceof TypeError && cause.message === "fetch failed")
    || (isRecord(cause) && typeof cause.code === "string" && NETWORK_FAILURE_CODES.has(cause.code)));
}

function externalHandshakeApiError(
  error: unknown,
  diagnostics: EnterpriseMcpDiagnosticEvent[],
): ApiError | null {
  if (!(error instanceof EnterpriseMcpClientError)
    || error.cause instanceof AggregateError
    || error.requestPhase === null) {
    return null;
  }
  const recognizedHandshake = (error.operationPhase === "connection-handshake"
      && error.code === "MCP_CONNECTION_HANDSHAKE_FAILED")
    || (error.operationPhase === "authorization-callback"
      && error.code === "MCP_AUTHORIZATION_CALLBACK_FAILED");
  if (!recognizedHandshake) return null;
  const request = lastHandshakeRequestDiagnostic(diagnostics);
  if (!request || request.outcome !== "failed" || !hasConcreteRequestCause(error, request)) return null;
  return new ApiError(502, "managed_mcp_connection_failed", MANAGED_MCP_CONNECTION_FAILED_MESSAGE);
}

async function rethrowConnectionFailure(
  config: ServerConfig,
  workspaceId: string,
  name: string,
  error: unknown,
  diagnostics: EnterpriseMcpDiagnosticEvent[],
  internalFallback: string,
): Promise<never> {
  const apiError = externalHandshakeApiError(error, diagnostics);
  await updateConnectionStatus(
    config,
    workspaceId,
    name,
    "reconnect_required",
    apiError?.message ?? internalFallback,
  );
  throw apiError ?? error;
}

async function verifyTools(
  config: ServerConfig,
  workspaceId: string,
  name: string,
  redirectUri: string,
  diagnostics: EnterpriseMcpDiagnosticEvent[],
): Promise<void> {
  const connection = await enterpriseConnection(config, workspaceId, name);
  await enterpriseClient(diagnostics).listTools({ connection, redirectUri });
  await updateConnectionStatus(config, workspaceId, name, "connected");
}

async function markReconnectWhenCredentialIsGone(
  config: ServerConfig,
  workspaceId: string,
  name: string,
  error: unknown,
  fallback: string,
): Promise<boolean> {
  const { hasCredential, alreadyReconnectRequired } = await withVaultRead(config, (vault) => {
    const connection = requireConnection(vault, workspaceId, name);
    return {
      hasCredential: Boolean(connection.credential),
      alreadyReconnectRequired: connection.status === "reconnect_required",
    };
  });
  // A connection that already needs a reconnect keeps its original reason
  // (e.g. the secure-storage recovery copy); later tool-discovery failures
  // must not overwrite it. Every other status still records this error.
  if (!hasCredential && !alreadyReconnectRequired) {
    await updateConnectionStatus(config, workspaceId, name, "reconnect_required", error instanceof Error ? error.message : fallback);
  }
  return !hasCredential;
}

export async function startLocalManagedMcpAuthorization(config: ServerConfig, workspaceId: string, name: string) {
  await withVaultMutation(config, (vault) => {
    const connection = requireConnection(vault, workspaceId, name);
    connection.enabled = true;
    connection.updatedAt = Date.now();
  });
  await updateConnectionStatus(config, workspaceId, name, "connecting");
  await writeManagedRuntimeEntry(config, workspaceId, name, true);
  const authorizationId = await createAuthorizationState(config, workspaceId, name);
  const redirectUri = localManagedMcpCallbackUrl(config);
  const diagnostics: EnterpriseMcpDiagnosticEvent[] = [];
  try {
    const connection = await enterpriseConnection(config, workspaceId, name);
    const result = await enterpriseClient(diagnostics).connect({ connection, redirectUri, authorizationId });
    if (result.status === "connected") {
      await verifyTools(config, workspaceId, name, redirectUri, diagnostics);
      return { status: "connected" as const };
    }
    await updateConnectionStatus(config, workspaceId, name, "needs_auth");
    return { status: "needs_auth" as const, authorizeUrl: result.authorizeUrl };
  } catch (error) {
    return rethrowConnectionFailure(config, workspaceId, name, error, diagnostics, "Connection failed");
  }
}

export async function completeLocalManagedMcpAuthorization(
  config: ServerConfig,
  state: string,
  code: string,
): Promise<{ connection: LocalManagedMcpPublicConnection; workspaceId: string }> {
  const payload = await verifyAuthorizationState(config, state);
  const diagnostics: EnterpriseMcpDiagnosticEvent[] = [];
  try {
    const connection = await enterpriseConnection(config, payload.workspaceId, payload.name);
    await enterpriseClient(diagnostics).completeAuthorization({
      connection,
      redirectUri: payload.redirectUri,
      code,
      authorizationId: state,
    });
    await verifyTools(config, payload.workspaceId, payload.name, payload.redirectUri, diagnostics);
    await writeManagedRuntimeEntry(config, payload.workspaceId, payload.name, true);
    return {
      connection: await getLocalManagedMcpConnection(config, payload.workspaceId, payload.name),
      workspaceId: payload.workspaceId,
    };
  } catch (error) {
    return rethrowConnectionFailure(config, payload.workspaceId, payload.name, error, diagnostics, "Authorization failed");
  }
}

export async function setLocalManagedMcpEnabled(
  config: ServerConfig,
  workspaceId: string,
  name: string,
  enabled: boolean,
): Promise<boolean> {
  const updated = await withVaultMutation(config, (vault) => {
    const connection = vault.connections[connectionKey(workspaceId, name)];
    if (!connection) return false;
    connection.enabled = enabled;
    connection.updatedAt = Date.now();
    return true;
  }, (changed) => changed);
  if (updated) await writeManagedRuntimeEntry(config, workspaceId, name, enabled);
  return updated;
}

export async function disconnectLocalManagedMcp(config: ServerConfig, workspaceId: string, name: string): Promise<boolean> {
  const exists = await withVaultRead(config, (vault) => Boolean(vault.connections[connectionKey(workspaceId, name)]));
  if (!exists) return false;
  await withVaultMutation(config, (vault) => {
    const connection = requireConnection(vault, workspaceId, name);
    delete connection.credential;
    connection.authorizations = {};
    connection.enabled = false;
    connection.status = "needs_auth";
    delete connection.lastError;
    connection.updatedAt = Date.now();
  });
  await writeManagedRuntimeEntry(config, workspaceId, name, false);
  return true;
}

export async function deleteLocalManagedMcp(config: ServerConfig, workspaceId: string, name: string): Promise<boolean> {
  const removed = await withVaultMutation(config, (vault) => {
    const key = connectionKey(workspaceId, name);
    if (!vault.connections[key]) return false;
    delete vault.connections[key];
    return true;
  }, (changed) => changed);
  if (removed) await removeManagedRuntimeEntry(config, workspaceId, name);
  return removed;
}

function bearerToken(request: Request): string | null {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

export function authorizeLocalManagedMcpGateway(config: ServerConfig, request: Request, workspaceId: string, name: string): boolean {
  const supplied = bearerToken(request);
  if (!supplied) return false;
  const expected = gatewayToken(config, workspaceId, name);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(suppliedBytes, expectedBytes);
}

export async function handleLocalManagedMcpGateway(
  config: ServerConfig,
  request: Request,
  workspaceId: string,
  name: string,
): Promise<Response> {
  if (!authorizeLocalManagedMcpGateway(config, request, workspaceId, name)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const stored = await withVaultRead(config, (vault) => requireConnection(vault, workspaceId, name));
  if (!stored.enabled) {
    return new Response(JSON.stringify({ error: "connection_disabled" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  const redirectUri = localManagedMcpCallbackUrl(config);
  const server = new Server(
    { name: `openwork-local-${name}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const connection = await enterpriseConnection(config, workspaceId, name);
      return { tools: await enterpriseClient().listTools({ connection, redirectUri }) };
    } catch (error) {
      const reconnect = await markReconnectWhenCredentialIsGone(config, workspaceId, name, error, "Tool discovery failed");
      throw new McpError(
        ErrorCode.InternalError,
        reconnect
          ? "This MCP connection needs to be reconnected in OpenWork."
          : "This MCP tool catalog could not be loaded. Retry the request.",
      );
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    try {
      const connection = await enterpriseConnection(config, workspaceId, name);
      const args = call.params.arguments ?? {};
      return await enterpriseClient().callTool({
        connection,
        redirectUri,
        toolName: call.params.name,
        arguments: args,
      });
    } catch (error) {
      const reconnect = await markReconnectWhenCredentialIsGone(config, workspaceId, name, error, "Tool execution failed");
      throw new McpError(
        ErrorCode.InternalError,
        reconnect
          ? "This MCP tool could not run. Reconnect it in OpenWork and retry."
          : "This MCP tool could not run. Review the tool input or provider response and retry.",
      );
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: [`127.0.0.1:${config.port}`, `localhost:${config.port}`],
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
