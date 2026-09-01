import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { provisionDesktopSandbox, deleteSandboxes, daytonaSandbox } from "@openwork/hosts";
import { createConnection } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import type {
  ChromeSurfaceOptions,
  ElectronSurfaceOptions,
  Host,
  SurfaceHandle,
} from "@openwork/hosts";

export const DEFAULT_MYSQL_URL = "mysql://root:password@127.0.0.1:3306";

export interface DbHandle extends AsyncDisposable {
  name: string;
  url: string;
  exists(): Promise<boolean>;
  drop(): Promise<void>;
}

export type DenBase =
  | { kind: "local"; apiHost: "127.0.0.1"; webHost: "127.0.0.1" }
  | { kind: "daytona"; ref: string };

/** One placement decision shared by every resource in a test. */
export interface Place {
  kind: "local" | "daytona";
  host(): Host | undefined;
  db(name: string): Promise<DbHandle>;
  exposeMock(handle: { url: string }): Promise<URL>;
  denBase(): DenBase;
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateDatabaseName(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Invalid ephemeral database name: ${name}`);
  }
}

function rootDatabaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

async function databaseExists(mysqlUrl: URL, name: string): Promise<boolean> {
  const connection = await createConnection(mysqlUrl.toString());
  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?",
      [name],
    );
    return rows.length > 0;
  } finally {
    await connection.end();
  }
}

export function ephemeralDatabaseName(prefix = "openwork_eval"): string {
  const timestamp = Date.now().toString(36);
  const nonce = randomBytes(6).toString("hex");
  return `${prefix}_${process.pid}_${timestamp}_${nonce}`.toLowerCase();
}

async function canConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    // 750ms missed Docker Desktop's lazy port-proxy under load and skipped
    // tests that should have run; 2.5s keeps the probe honest without stalling.
    socket.setTimeout(2_500);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

export async function localMysqlIsRunning(): Promise<boolean> {
  // Probe the same MySQL the run will actually use: OPENWORK_EVAL_MYSQL_URL
  // overrides the default, so the probe must honor it too.
  const url = new URL(process.env.OPENWORK_EVAL_MYSQL_URL?.trim() || DEFAULT_MYSQL_URL);
  const port = url.port ? Number(url.port) : 3306;
  return canConnect(port, url.hostname || "127.0.0.1");
}

/**
 * den-api's dev script defaults DATABASE_REDIS_URL to redis://127.0.0.1:6379
 * (root package.json, `${DATABASE_REDIS_URL:-...}`), and since #3679 its cached
 * auth reads retry against that endpoint. An unreachable Redis therefore stalls
 * sign-in instead of failing, so local lanes gate on it the way they gate MySQL.
 */
export async function localRedisIsRunning(): Promise<boolean> {
  return canConnect(6379, "127.0.0.1");
}

class LocalPlace implements Place {
  readonly kind = "local";
  readonly #mysqlUrl: URL;

  constructor(mysqlUrl: string) {
    this.#mysqlUrl = rootDatabaseUrl(mysqlUrl);
  }

  host(): undefined {
    return undefined;
  }

  denBase(): DenBase {
    return { kind: "local", apiHost: "127.0.0.1", webHost: "127.0.0.1" };
  }

  async db(name: string): Promise<DbHandle> {
    validateDatabaseName(name);
    const connection = await createConnection(this.#mysqlUrl.toString());
    try {
      await connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } finally {
      await connection.end();
    }
    const databaseUrl = new URL(this.#mysqlUrl);
    databaseUrl.pathname = `/${name}`;
    let dropped = false;
    const drop = async (): Promise<void> => {
      if (dropped) return;
      dropped = true;
      const root = await createConnection(this.#mysqlUrl.toString());
      try {
        await root.query(`DROP DATABASE IF EXISTS \`${name}\``);
      } finally {
        await root.end();
      }
    };
    return {
      name,
      url: databaseUrl.toString(),
      exists: () => databaseExists(this.#mysqlUrl, name),
      drop,
      [Symbol.asyncDispose]: drop,
    };
  }

  async exposeMock(handle: { url: string }): Promise<URL> {
    return new URL(handle.url);
  }
}

interface PlacedSurface {
  host: Host;
  sandbox: string;
  created: boolean;
}

/** Provisions one isolated sandbox for each app surface, only when it is used. */
class DaytonaPlacementHost implements Host {
  readonly kind = "daytona";
  readonly workspaceRoot = "/workspace";
  readonly #ref: string;
  readonly #preparedSandbox: string | undefined;
  readonly #preparedHost: Host | undefined;
  readonly #surfaces = new Map<SurfaceHandle, PlacedSurface>();

  constructor(ref: string, preparedSandbox?: string) {
    this.#ref = ref;
    this.#preparedSandbox = preparedSandbox;
    this.#preparedHost = preparedSandbox ? daytonaSandbox(preparedSandbox) : undefined;
  }

  async #provision(name: string): Promise<PlacedSurface> {
    if (this.#preparedSandbox && this.#preparedHost) {
      return {
        host: this.#preparedHost,
        sandbox: this.#preparedSandbox,
        created: false,
      };
    }
    const provisioned = await provisionDesktopSandbox({
      ref: this.#ref,
      name,
      log: (line) => console.error(`[openwork/testkit] ${line}`),
    });
    return {
      host: daytonaSandbox(provisioned.sandbox),
      sandbox: provisioned.sandbox,
      created: provisioned.created,
    };
  }

  async spawnElectron(name: string, options?: ElectronSurfaceOptions): Promise<SurfaceHandle> {
    const placed = await this.#provision(name);
    try {
      const handle = await placed.host.spawnElectron(name, options);
      this.#surfaces.set(handle, placed);
      return handle;
    } catch (error) {
      if (placed.created) {
        await deleteSandboxes([placed.sandbox]).catch((cleanupError: unknown) => {
          console.error(`[openwork/testkit] Daytona cleanup failed: ${messageText(cleanupError)}`);
        });
      }
      throw error;
    }
  }

  async spawnChrome(name: string, options?: ChromeSurfaceOptions): Promise<SurfaceHandle> {
    const placed = await this.#provision(name);
    try {
      const handle = await placed.host.spawnChrome(name, options);
      this.#surfaces.set(handle, placed);
      return handle;
    } catch (error) {
      if (placed.created) {
        await deleteSandboxes([placed.sandbox]).catch((cleanupError: unknown) => {
          console.error(`[openwork/testkit] Daytona cleanup failed: ${messageText(cleanupError)}`);
        });
      }
      throw error;
    }
  }

  async disposeSurface(handle: SurfaceHandle): Promise<void> {
    const placed = this.#surfaces.get(handle);
    if (!placed) return;
    this.#surfaces.delete(handle);
    try {
      await placed.host.disposeSurface(handle);
    } finally {
      if (placed.created) await deleteSandboxes([placed.sandbox]);
    }
  }
}

class DaytonaPlace implements Place {
  readonly kind = "daytona";
  readonly #ref: string;
  readonly #host: Host;

  constructor(ref: string, preparedDesktopSandbox?: string) {
    this.#ref = ref;
    this.#host = new DaytonaPlacementHost(ref, preparedDesktopSandbox);
  }

  host(): Host {
    return this.#host;
  }

  denBase(): DenBase {
    return { kind: "daytona", ref: this.#ref };
  }

  async db(_name: string): Promise<DbHandle> {
    throw new Error("Daytona Den databases are owned by the provisioned Den sandbox.");
  }

  async exposeMock(handle: { url: string }): Promise<URL> {
    const url = new URL(handle.url);
    if (["127.0.0.1", "localhost", "0.0.0.0", "::1"].includes(url.hostname)) {
      throw new Error("mock is unreachable from remote den");
    }
    return url;
  }
}

/** Resolve placement once; resources never inspect placement environment again. */
export function resolvePlace(env: NodeJS.ProcessEnv = process.env): Place {
  const worldPlace = env.OPENWORK_WORLD_PLACE?.trim() || undefined;
  const useDaytona = worldPlace === "daytona"
    || (worldPlace === undefined && env.OPENWORK_EVAL_DAYTONA?.trim() === "1");
  if (useDaytona) {
    const ref = env.OPENWORK_EVAL_REF?.trim() || env.GITHUB_SHA?.trim() || "dev";
    return new DaytonaPlace(ref, env.OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX?.trim());
  }
  return new LocalPlace(env.OPENWORK_EVAL_MYSQL_URL?.trim() || DEFAULT_MYSQL_URL);
}
