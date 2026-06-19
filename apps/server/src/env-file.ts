import { homedir, platform } from "node:os";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ensureDir, exists } from "./utils.js";

// User-level environment variables, persisted so the desktop shell can inject
// them into every spawned child (OpenCode, OpenWork server, opencode-router).
// Motivation: Linux GUI launches don't inherit shell env, so users set
// ANTHROPIC_API_KEY / GCLOUD_* / GCP_* in .bashrc and hit silent auth failures.
// Scope: user/machine, not workspace. Not synced to the cloud.

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Keys reserved for internal wiring by the shell/orchestrator/server. This UI
// is for service credentials, not OpenWork/OpenCode runtime knobs; users who
// need OPENCODE_* process settings should set them from the launching shell.
// We refuse writes to these and strip them when reading for injection, so a
// tampered file cannot shadow auth credentials, token paths, or process
// identity.
const RESERVED_PREFIXES = ["OPENWORK_", "OPENCODE_"] as const;

export type EnvRecord = {
  key: string;
  value: string;
  updatedAt: number;
};

type EnvStoreFile = {
  schemaVersion: number;
  updatedAt: number;
  variables: EnvRecord[];
};

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_PATTERN.test(key);
}

export function isReservedEnvKey(key: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// Deterministic, matches what the Rust/Node shells compute independently.
// Do NOT key this off ServerConfig.configPath — the shell resolves the path
// before the server config exists, and must agree with us byte-for-byte.
export function resolveDefaultEnvStorePath(): string {
  const override = (process.env.OPENWORK_ENV_STORE ?? "").trim();
  if (override) return resolve(override);

  if (platform() === "win32") {
    const appData = (process.env.APPDATA ?? "").trim();
    const root = appData || join(homedir(), "AppData", "Roaming");
    return join(root, "openwork", "env.json");
  }
  return join(homedir(), ".config", "openwork", "env.json");
}

function parseRecord(raw: unknown): EnvRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<EnvRecord>;
  const key = typeof record.key === "string" ? record.key : "";
  const value = typeof record.value === "string" ? record.value : "";
  if (!isValidEnvKey(key)) return null;
  return {
    key,
    value,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
  };
}

function emptyStore(): EnvStoreFile {
  return { schemaVersion: 1, updatedAt: Date.now(), variables: [] };
}

async function readStore(
  path: string,
  options: { tolerateInvalid?: boolean } = {},
): Promise<EnvStoreFile> {
  if (!(await exists(path))) {
    return emptyStore();
  }
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return emptyStore();
    if (options.tolerateInvalid) return emptyStore();
    throw new EnvStoreReadError("Environment variable store could not be read");
  }

  let parsed: Partial<EnvStoreFile>;
  try {
    parsed = JSON.parse(raw) as Partial<EnvStoreFile>;
  } catch {
    if (options.tolerateInvalid) return emptyStore();
    throw new EnvStoreReadError("Environment variable store is invalid JSON");
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.variables)) {
    if (options.tolerateInvalid) return emptyStore();
    throw new EnvStoreReadError("Environment variable store has an invalid format");
  }

  const variables = parsed.variables
    .map(parseRecord)
    .filter((entry): entry is EnvRecord => Boolean(entry));
  return {
    schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    variables,
  };
}

async function writeStore(path: string, variables: EnvRecord[]): Promise<void> {
  const dir = dirname(path);
  await ensureDir(dir);
  const payload: EnvStoreFile = {
    schemaVersion: 1,
    updatedAt: Date.now(),
    variables,
  };
  const tempPath = join(
    dir,
    `.env.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await writeFile(tempPath, JSON.stringify(payload, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await chmod(tempPath, 0o600);
  } catch (error) {
    // chmod is a no-op on Windows; values may still contain secrets.
    if (platform() !== "win32") {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  try {
    await chmod(path, 0o600);
  } catch (error) {
    // chmod is a no-op on Windows; values may still contain secrets.
    if (platform() !== "win32") throw error;
  }
}

export type EnvEntry = { key: string; value: string };

export class EnvService {
  private readonly path: string;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private variables: EnvRecord[] = [];

  constructor(options?: { path?: string }) {
    this.path = options?.path ? resolve(options.path) : resolveDefaultEnvStorePath();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = readStore(this.path)
        .then((store) => {
          this.variables = store.variables;
          this.loaded = true;
        })
        .finally(() => {
          this.loadPromise = null;
        });
    }
    await this.loadPromise;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.catch(() => {}).then(operation);
    this.mutationQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async list(): Promise<EnvRecord[]> {
    await this.ensureLoaded();
    return this.variables.slice();
  }

  async upsertMany(entries: EnvEntry[]): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.ensureLoaded();
      const now = Date.now();
      const next = new Map(this.variables.map((entry) => [entry.key, entry] as const));
      for (const entry of entries) {
        if (!isValidEnvKey(entry.key)) {
          throw new InvalidEnvKeyError(entry.key, "invalid_env_key");
        }
        if (isReservedEnvKey(entry.key)) {
          throw new InvalidEnvKeyError(entry.key, "reserved_env_key");
        }
        next.set(entry.key, { key: entry.key, value: entry.value, updatedAt: now });
      }
      const nextVariables = Array.from(next.values()).sort((a, b) => a.key.localeCompare(b.key));
      await writeStore(this.path, nextVariables);
      this.variables = nextVariables;
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      await this.ensureLoaded();
      const before = this.variables.length;
      const nextVariables = this.variables.filter((entry) => entry.key !== key);
      if (nextVariables.length === before) return false;
      await writeStore(this.path, nextVariables);
      this.variables = nextVariables;
      return true;
    });
  }

  // Used by the Electron + orchestrator shells at spawn time. Keep the
  // loaders in apps/desktop/electron/runtime.mjs and apps/orchestrator/src/cli.ts
  // byte-for-byte in sync on path resolution and reserved-keys policy.
  static async readForInjection(overridePath?: string): Promise<Record<string, string>> {
    const path = overridePath?.trim() ? resolve(overridePath.trim()) : resolveDefaultEnvStorePath();
    const store = await readStore(path, { tolerateInvalid: true });
    const out: Record<string, string> = {};
    for (const entry of store.variables) {
      if (isReservedEnvKey(entry.key)) continue;
      out[entry.key] = entry.value;
    }
    return out;
  }
}

export class EnvStoreReadError extends Error {
  readonly code = "invalid_env_store";
}

export class InvalidEnvKeyError extends Error {
  readonly code: "invalid_env_key" | "reserved_env_key";
  constructor(key: string, code: "invalid_env_key" | "reserved_env_key") {
    super(
      code === "reserved_env_key"
        ? `Environment variable name is reserved for OpenWork internals: ${key}`
        : `Invalid environment variable name: ${key}`,
    );
    this.code = code;
  }
}
