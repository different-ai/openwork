import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  EnterpriseMcpOAuthAuthorizationHandle,
  EnterpriseMcpOAuthClientRegistration,
  EnterpriseMcpOAuthCredential,
  EnterpriseMcpOAuthPersistence,
  EnterpriseMcpPersistenceContext,
} from "@openwork/enterprise-mcp-client";
import type {
  ConnectAuthType as PortableConnectAuthType,
  ConnectConnection,
  ConnectConnectionInput,
  ConnectConnectionStatus as PortableConnectConnectionStatus,
  ConnectMode as PortableConnectMode,
} from "@openwork/connect-core/profile";
import { z } from "zod";

import { runtimeDbPath } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { ConnectLocalVault } from "./connect-local-vault.js";
import { openConnectSqlite, type ConnectSqliteDatabase } from "./connect-sqlite.js";

export type ConnectMode = PortableConnectMode;
export type ConnectLocalAuthType = PortableConnectAuthType;
export type ConnectLocalConnectionStatus = PortableConnectConnectionStatus;
export type ConnectLocalConnection = ConnectConnection;
export type ConnectLocalConnectionInput = ConnectConnectionInput;

const storedAuthorizationSchema = z.object({
  idHash: z.string().length(64),
  revision: z.string().min(1),
  codeVerifier: z.string().min(1),
  expiresAt: z.number().int().positive(),
  clientRegistrationRevision: z.string().min(1).optional(),
});

const connectionSecretSchema = z.object({
  apiKey: z.string().optional(),
  clientRegistration: z.object({
    clientInformation: z.record(z.string(), z.unknown()),
    revision: z.string().min(1),
    redirectUri: z.string().url().optional(),
    expiresAt: z.number().int().positive().optional(),
    source: z.enum(["pre-registered", "dynamic"]),
  }).optional(),
  credential: z.object({
    tokens: z.record(z.string(), z.unknown()),
    expiresAt: z.number().int().positive().optional(),
    revision: z.string().min(1),
  }).optional(),
  authorizations: z.array(storedAuthorizationSchema).max(8).default([]),
});

type ConnectionSecret = z.infer<typeof connectionSecretSchema>;

const connectionRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  server_url: z.string(),
  auth_type: z.enum(["none", "api-key", "oauth"]),
  network_policy: z.enum(["public", "private"]),
  status: z.enum(["disconnected", "connected", "needs_auth", "error"]),
  last_error: z.string().nullable(),
  secret_cipher: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

function assertCommitActive(context: EnterpriseMcpPersistenceContext, now = Date.now()): void {
  if (context.signal.aborted || now >= context.commitExpiresAt) {
    throw new Error("The local Connect persistence deadline expired before the transaction could commit.");
  }
}

function stateHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseClientInformation(value: Record<string, unknown>): OAuthClientInformationMixed {
  const full = OAuthClientInformationFullSchema.safeParse(value);
  if (full.success) return full.data;
  return OAuthClientInformationSchema.parse(value);
}

function publicConnection(row: z.infer<typeof connectionRowSchema>): ConnectLocalConnection {
  return {
    id: row.id,
    name: row.name,
    serverUrl: row.server_url,
    authType: row.auth_type,
    networkPolicy: row.network_policy,
    status: row.status,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ConnectLocalStore {
  private readonly db: ConnectSqliteDatabase;
  private readonly vault?: ConnectLocalVault;

  constructor(config: ServerConfig, vault?: ConnectLocalVault) {
    const path = runtimeDbPath(config);
    mkdirSync(dirname(path), { recursive: true });
    this.db = openConnectSqlite(path);
    this.vault = vault;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connect_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL,
        agent_revision TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connect_connections (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        auth_type TEXT NOT NULL,
        network_policy TEXT NOT NULL DEFAULT 'public',
        status TEXT NOT NULL,
        last_error TEXT,
        secret_cipher TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const profileColumns = this.db.prepare("PRAGMA table_info(connect_profile)").all();
    const hasAgentRevision = profileColumns.some((column) => (
      typeof column === "object" && column !== null && "name" in column && column.name === "agent_revision"
    ));
    if (!hasAgentRevision) {
      this.db.exec("ALTER TABLE connect_profile ADD COLUMN agent_revision TEXT NOT NULL DEFAULT 'legacy';");
    }
    const connectionColumns = this.db.prepare("PRAGMA table_info(connect_connections)").all();
    const hasNetworkPolicy = connectionColumns.some((column) => (
      typeof column === "object" && column !== null && "name" in column && column.name === "network_policy"
    ));
    if (!hasNetworkPolicy) {
      this.db.exec("ALTER TABLE connect_connections ADD COLUMN network_policy TEXT NOT NULL DEFAULT 'public';");
    }
    this.db.prepare("INSERT OR IGNORE INTO connect_profile (id, mode, agent_revision, updated_at) VALUES (1, 'hosted', ?, ?)")
      .run(randomUUID(), Date.now());
  }

  mode(): ConnectMode {
    const row = this.db.prepare("SELECT mode FROM connect_profile WHERE id = 1").get();
    if (typeof row === "object" && row !== null && "mode" in row) {
      const mode = row.mode;
      if (mode === "hosted" || mode === "local" || mode === "disabled") return mode;
    }
    return "hosted";
  }

  setMode(mode: ConnectMode): void {
    this.db.prepare("UPDATE connect_profile SET mode = ?, agent_revision = ?, updated_at = ? WHERE id = 1")
      .run(mode, randomUUID(), Date.now());
  }

  agentRevision(): string {
    const row = this.db.prepare("SELECT agent_revision FROM connect_profile WHERE id = 1").get();
    if (typeof row === "object" && row !== null && "agent_revision" in row && typeof row.agent_revision === "string") {
      return row.agent_revision;
    }
    throw new Error("The local Connect agent credential revision is unavailable.");
  }

  listConnections(): ConnectLocalConnection[] {
    return this.db.prepare("SELECT * FROM connect_connections ORDER BY name COLLATE NOCASE, id").all()
      .map((row) => publicConnection(connectionRowSchema.parse(row)));
  }

  getConnection(id: string): ConnectLocalConnection | null {
    const row = this.db.prepare("SELECT * FROM connect_connections WHERE id = ?").get(id);
    return row ? publicConnection(connectionRowSchema.parse(row)) : null;
  }

  createConnection(input: ConnectLocalConnectionInput): ConnectLocalConnection {
    const id = `cn_${randomUUID()}`;
    const now = Date.now();
    const secret: ConnectionSecret = {
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(input.oauthClient ? {
        clientRegistration: {
          clientInformation: {
            client_id: input.oauthClient.clientId,
            ...(input.oauthClient.clientSecret ? { client_secret: input.oauthClient.clientSecret } : {}),
          },
          revision: randomUUID(),
          source: "pre-registered",
        },
      } : {}),
      authorizations: [],
    };
    const status: ConnectLocalConnectionStatus = input.authType === "oauth" ? "needs_auth" : "disconnected";
    this.db.prepare(`
      INSERT INTO connect_connections (
        id, name, server_url, auth_type, network_policy, status, last_error, secret_cipher, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.serverUrl,
      input.authType,
      input.allowPrivateNetwork ? "private" : "public",
      status,
      this.requireVault().encrypt(secret, `connection:${id}`),
      now,
      now,
    );
    const created = this.getConnection(id);
    if (!created) throw new Error("The local Connect connection was not persisted.");
    return created;
  }

  deleteConnection(id: string): boolean {
    return this.db.prepare("DELETE FROM connect_connections WHERE id = ?").run(id).changes > 0;
  }

  setConnectionStatus(id: string, status: ConnectLocalConnectionStatus, lastError?: string): void {
    this.db.prepare("UPDATE connect_connections SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(status, lastError?.trim() || null, Date.now(), id);
  }

  apiKey(id: string): string | undefined {
    return this.readSecret(id).apiKey;
  }

  clearCredentials(id: string): void {
    this.updateSecret(id, (secret) => ({
      ...secret,
      credential: undefined,
      authorizations: [],
    }));
  }

  private readSecret(id: string): ConnectionSecret {
    const row = this.db.prepare("SELECT secret_cipher FROM connect_connections WHERE id = ?").get(id);
    if (typeof row !== "object" || row === null || !("secret_cipher" in row) || typeof row.secret_cipher !== "string") {
      throw new Error("The local Connect connection does not exist.");
    }
    return connectionSecretSchema.parse(this.requireVault().decrypt(row.secret_cipher, `connection:${id}`));
  }

  private updateSecret(id: string, update: (secret: ConnectionSecret) => ConnectionSecret): ConnectionSecret {
    return this.db.immediate(() => {
      const current = this.readSecret(id);
      const next = connectionSecretSchema.parse(update(current));
      const result = this.db.prepare("UPDATE connect_connections SET secret_cipher = ?, updated_at = ? WHERE id = ?")
        .run(this.requireVault().encrypt(next, `connection:${id}`), Date.now(), id);
      if (result.changes !== 1) throw new Error("The local Connect connection disappeared during credential update.");
      return next;
    });
  }

  oauthPersistence(connectionId: string, redirectUri: string): EnterpriseMcpOAuthPersistence {
    const store = this;
    return {
      clientRegistrations: {
        load: async (context): Promise<EnterpriseMcpOAuthClientRegistration | undefined> => {
          assertCommitActive(context);
          const registration = store.readSecret(connectionId).clientRegistration;
          if (!registration) return undefined;
          if (registration.source === "dynamic" && registration.redirectUri !== redirectUri) return undefined;
          return {
            clientInformation: parseClientInformation(registration.clientInformation),
            revision: registration.revision,
            ...(registration.expiresAt ? { expiresAt: registration.expiresAt } : {}),
            source: registration.source,
          };
        },
        save: async (input): Promise<EnterpriseMcpOAuthClientRegistration> => {
          assertCommitActive(input.context);
          const next = store.updateSecret(connectionId, (secret) => {
            if (secret.clientRegistration?.source === "pre-registered") return secret;
            if (secret.clientRegistration?.redirectUri === redirectUri) return secret;
            return {
              ...secret,
              clientRegistration: {
                clientInformation: { ...input.clientInformation },
                revision: randomUUID(),
                redirectUri,
                ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
                source: "dynamic",
              },
            };
          });
          assertCommitActive(input.context);
          const registration = next.clientRegistration;
          if (!registration) throw new Error("The OAuth client registration was not persisted.");
          return {
            clientInformation: parseClientInformation(registration.clientInformation),
            revision: registration.revision,
            ...(registration.expiresAt ? { expiresAt: registration.expiresAt } : {}),
            source: registration.source,
          };
        },
        invalidate: async (input): Promise<void> => {
          assertCommitActive(input.context);
          store.updateSecret(connectionId, (secret) => ({ ...secret, clientRegistration: undefined }));
        },
      },
      credentials: {
        load: async (context): Promise<EnterpriseMcpOAuthCredential | undefined> => {
          assertCommitActive(context);
          const credential = store.readSecret(connectionId).credential;
          if (!credential) return undefined;
          return {
            tokens: OAuthTokensSchema.parse(credential.tokens),
            revision: credential.revision,
            ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
          };
        },
        save: async (input): Promise<void> => {
          assertCommitActive(input.context);
          store.updateSecret(connectionId, (secret) => {
            const authorizations = [...secret.authorizations];
            if (input.source === "authorization-code") {
              const authorization = input.authorization;
              if (!authorization) throw new Error("OAuth authorization-code persistence requires a transaction handle.");
              const index = authorizations.findIndex((candidate) => (
                candidate.idHash === stateHash(authorization.id) && candidate.revision === authorization.revision
              ));
              const pending = index >= 0 ? authorizations[index] : undefined;
              if (!pending || pending.expiresAt <= Date.now()) throw new Error("The OAuth authorization transaction is missing or expired.");
              if (pending.clientRegistrationRevision !== input.clientRegistrationRevision) {
                throw new Error("The OAuth client registration changed during authorization.");
              }
              authorizations.splice(index, 1);
            }
            return {
              ...secret,
              credential: {
                tokens: { ...input.tokens },
                revision: randomUUID(),
                ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
              },
              authorizations,
            };
          });
          assertCommitActive(input.context);
        },
        invalidate: async (input): Promise<void> => {
          assertCommitActive(input.context);
          store.updateSecret(connectionId, (secret) => ({ ...secret, credential: undefined }));
        },
      },
      authorizations: {
        begin: async (input): Promise<void> => {
          assertCommitActive(input.context);
          store.updateSecret(connectionId, (secret) => {
            const active = secret.authorizations.filter((candidate) => candidate.expiresAt > Date.now());
            if (active.length >= 8) throw new Error("Too many local Connect OAuth authorizations are pending.");
            return {
              ...secret,
              authorizations: [
                ...active.filter((candidate) => candidate.idHash !== stateHash(input.id)),
                {
                  idHash: stateHash(input.id),
                  revision: randomUUID(),
                  codeVerifier: input.codeVerifier,
                  expiresAt: input.expiresAt,
                  ...(input.clientRegistrationRevision
                    ? { clientRegistrationRevision: input.clientRegistrationRevision }
                    : {}),
                },
              ],
            };
          });
          assertCommitActive(input.context);
        },
        load: async (input): Promise<{ handle: EnterpriseMcpOAuthAuthorizationHandle; codeVerifier: string } | undefined> => {
          assertCommitActive(input.context);
          const pending = store.readSecret(connectionId).authorizations.find((candidate) => (
            candidate.idHash === stateHash(input.id) && candidate.expiresAt > Date.now()
          ));
          if (!pending) return undefined;
          return {
            handle: {
              id: input.id,
              revision: pending.revision,
              expiresAt: pending.expiresAt,
              ...(pending.clientRegistrationRevision
                ? { clientRegistrationRevision: pending.clientRegistrationRevision }
                : {}),
            },
            codeVerifier: pending.codeVerifier,
          };
        },
        invalidate: async (input): Promise<void> => {
          assertCommitActive(input.context);
          store.updateSecret(connectionId, (secret) => ({
            ...secret,
            authorizations: secret.authorizations.filter((candidate) => candidate.idHash !== stateHash(input.id)),
          }));
        },
      },
    };
  }

  private requireVault(): ConnectLocalVault {
    if (!this.vault) throw new Error("The local Connect vault is unavailable.");
    return this.vault;
  }
}
