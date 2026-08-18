import { chmod } from "node:fs/promises";
import { platform } from "node:os";
import { openRuntimeSqliteDatabase, runtimeDbPath, type RuntimeSqliteDatabase } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";

export type FlueProviderCredential = {
  type: "api";
  key: string;
};

export type FlueProviderCredentialMap = Record<string, FlueProviderCredential>;

type StoredCredentialRow = {
  providerId: string;
  credentialJson: string;
};

type ProviderCredentialDb = {
  get: (providerId: string) => StoredCredentialRow | undefined;
  list: () => StoredCredentialRow[];
  upsert: (providerId: string, credentialJson: string, updatedAt: number) => void;
  remove: (providerId: string) => void;
};

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS flue_provider_credentials (
    provider_id TEXT PRIMARY KEY NOT NULL,
    credential_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;
const databases = new Map<string, Promise<ProviderCredentialDb>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storedCredentialRow(value: unknown): StoredCredentialRow | undefined {
  if (!isRecord(value) || typeof value.providerId !== "string" || typeof value.credentialJson !== "string") {
    return undefined;
  }
  return { providerId: value.providerId, credentialJson: value.credentialJson };
}

function storedCredentialRows(values: unknown[]): StoredCredentialRow[] {
  return values.flatMap((value) => {
    const row = storedCredentialRow(value);
    return row ? [row] : [];
  });
}

function parseCredential(value: string): FlueProviderCredential | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.type !== "api" || typeof parsed.key !== "string" || !parsed.key.trim()) {
      return undefined;
    }
    return { type: "api", key: parsed.key.trim() };
  } catch {
    return undefined;
  }
}

async function secureRuntimeDatabaseFile(path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch (error) {
    if (platform() !== "win32") throw error;
  }
}

async function openProviderCredentialDb(path: string): Promise<ProviderCredentialDb> {
  const runtime: RuntimeSqliteDatabase = await openRuntimeSqliteDatabase(path);
  await secureRuntimeDatabaseFile(path);
  if (runtime.kind === "bun") {
    runtime.sqlite.run(CREATE_TABLE_SQL);
    const get = runtime.sqlite.query("SELECT provider_id AS providerId, credential_json AS credentialJson FROM flue_provider_credentials WHERE provider_id = ?");
    const list = runtime.sqlite.query("SELECT provider_id AS providerId, credential_json AS credentialJson FROM flue_provider_credentials ORDER BY provider_id");
    const upsert = runtime.sqlite.query(`
      INSERT INTO flue_provider_credentials (provider_id, credential_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        credential_json = excluded.credential_json,
        updated_at = excluded.updated_at
    `);
    const remove = runtime.sqlite.query("DELETE FROM flue_provider_credentials WHERE provider_id = ?");
    return {
      get: (providerId) => storedCredentialRow(get.get(providerId)),
      list: () => storedCredentialRows(list.all()),
      upsert: (providerId, credentialJson, updatedAt) => {
        upsert.run(providerId, credentialJson, updatedAt);
      },
      remove: (providerId) => {
        remove.run(providerId);
      },
    };
  }

  runtime.sqlite.exec(CREATE_TABLE_SQL);
  const get = runtime.sqlite.prepare("SELECT provider_id AS providerId, credential_json AS credentialJson FROM flue_provider_credentials WHERE provider_id = ?");
  const list = runtime.sqlite.prepare("SELECT provider_id AS providerId, credential_json AS credentialJson FROM flue_provider_credentials ORDER BY provider_id");
  const upsert = runtime.sqlite.prepare(`
    INSERT INTO flue_provider_credentials (provider_id, credential_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(provider_id) DO UPDATE SET
      credential_json = excluded.credential_json,
      updated_at = excluded.updated_at
  `);
  const remove = runtime.sqlite.prepare("DELETE FROM flue_provider_credentials WHERE provider_id = ?");
  return {
    get: (providerId) => storedCredentialRow(get.get(providerId)),
    list: () => storedCredentialRows(list.all()),
    upsert: (providerId, credentialJson, updatedAt) => {
      upsert.run(providerId, credentialJson, updatedAt);
    },
    remove: (providerId) => {
      remove.run(providerId);
    },
  };
}

async function providerCredentialDb(config: ServerConfig): Promise<ProviderCredentialDb> {
  const path = runtimeDbPath(config);
  const existing = databases.get(path);
  if (existing) return existing;
  const database = openProviderCredentialDb(path);
  databases.set(path, database);
  return database;
}

export async function readFlueProviderCredential(
  config: ServerConfig,
  providerId: string,
): Promise<FlueProviderCredential | undefined> {
  const row = (await providerCredentialDb(config)).get(providerId);
  return row ? parseCredential(row.credentialJson) : undefined;
}

export async function readFlueProviderCredentials(config: ServerConfig): Promise<FlueProviderCredentialMap> {
  const credentials: FlueProviderCredentialMap = {};
  for (const row of (await providerCredentialDb(config)).list()) {
    const credential = parseCredential(row.credentialJson);
    if (credential) credentials[row.providerId] = credential;
  }
  return credentials;
}

export async function writeFlueProviderCredential(
  config: ServerConfig,
  providerId: string,
  credential: FlueProviderCredential,
): Promise<void> {
  (await providerCredentialDb(config)).upsert(providerId, JSON.stringify(credential), Date.now());
}

export async function removeFlueProviderCredential(config: ServerConfig, providerId: string): Promise<void> {
  (await providerCredentialDb(config)).remove(providerId);
}
