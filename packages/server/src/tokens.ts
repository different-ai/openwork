import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import type { ServerConfig, TokenScope } from "./types.js";
import { ensureDir, exists, hashToken, shortId } from "./utils.js";

export type TokenRecord = {
  id: string;
  hash: string;
  scope: TokenScope;
  createdAt: number;
  label?: string;
};

type TokenStoreFile = {
  schemaVersion: number;
  updatedAt: number;
  tokens: TokenRecord[];
};

function normalizeScope(value: unknown): TokenScope | null {
  if (value === "owner" || value === "collaborator" || value === "viewer") return value;
  return null;
}

function resolveTokenStorePath(config: ServerConfig): string {
  const override = (process.env.OPENWORK_TOKEN_STORE ?? "").trim();
  if (override) return resolve(override);

  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : join(homedir(), ".config", "openwork");
  return join(configDir, "tokens.json");
}

async function readTokenStore(path: string): Promise<TokenStoreFile> {
  if (!(await exists(path))) {
    return { schemaVersion: 1, updatedAt: Date.now(), tokens: [] };
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<TokenStoreFile>;
    const tokens = Array.isArray(parsed.tokens)
      ? parsed.tokens
        .map((token) => {
          const record = token as Partial<TokenRecord>;
          const id = typeof record.id === "string" ? record.id : "";
          const hash = typeof record.hash === "string" ? record.hash : "";
          const scope = normalizeScope(record.scope);
          const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now();
          const label = typeof record.label === "string" ? record.label : undefined;
          if (!id || !hash || !scope) return null;
          const parsedRecord: TokenRecord = {
            id,
            hash,
            scope,
            createdAt,
            ...(label ? { label } : {}),
          };
          return parsedRecord;
        })
        .filter((token): token is TokenRecord => Boolean(token))
      : [];
    return {
      schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      tokens,
    };
  } catch {
    return { schemaVersion: 1, updatedAt: Date.now(), tokens: [] };
  }
}

async function writeTokenStore(path: string, tokens: TokenRecord[]): Promise<void> {
  await ensureDir(dirname(path));
  const payload: TokenStoreFile = {
    schemaVersion: 1,
    updatedAt: Date.now(),
    tokens,
  };
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

export class TokenService {
  private config: ServerConfig;
  private path: string;
  private loaded = false;
  private tokens: TokenRecord[] = [];
  private byHash = new Map<string, TokenRecord>();

  constructor(config: ServerConfig) {
    this.config = config;
    this.path = resolveTokenStorePath(config);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const store = await readTokenStore(this.path);
    this.tokens = store.tokens;
    this.byHash = new Map(store.tokens.map((token) => [token.hash, token]));
    this.loaded = true;
  }

  async list(): Promise<Array<Omit<TokenRecord, "hash">>> {
    await this.ensureLoaded();
    return this.tokens.map(({ hash: _hash, ...rest }) => rest);
  }

  async create(scope: TokenScope, options?: { label?: string }): Promise<{ id: string; token: string; scope: TokenScope; createdAt: number; label?: string }> {
    await this.ensureLoaded();

    const id = shortId();
    const token = `owt_${shortId().replace(/-/g, "")}`;
    const createdAt = Date.now();
    const record: TokenRecord = {
      id,
      hash: hashToken(token),
      scope,
      createdAt,
      label: options?.label?.trim() || undefined,
    };

    this.tokens = [record, ...this.tokens];
    this.byHash.set(record.hash, record);
    await writeTokenStore(this.path, this.tokens);
    return { id, token, scope, createdAt, label: record.label };
  }

  async revoke(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const index = this.tokens.findIndex((token) => token.id === id);
    if (index === -1) return false;
    const [removed] = this.tokens.splice(index, 1);
    if (removed) {
      this.byHash.delete(removed.hash);
    }
    await writeTokenStore(this.path, this.tokens);
    return true;
  }

  async scopeForToken(token: string): Promise<TokenScope | null> {
    const trimmed = token.trim();
    if (!trimmed) return null;
    if (trimmed === this.config.token) return "collaborator";
    await this.ensureLoaded();
    const found = this.byHash.get(hashToken(trimmed));
    return found?.scope ?? null;
  }
}
