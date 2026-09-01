import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createConnection } from "mysql2/promise";
import { main as runWorldCli, parseWorldArgs, type PreflightCheck, type Reaper } from "@openwork/world";
import { DEFAULT_MYSQL_URL, localMysqlIsRunning, localRedisIsRunning } from "./place.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const WORLDS_DIRECTORY = fileURLToPath(new URL("../../../../worlds", import.meta.url));

const dockerCheck: PreflightCheck = {
  id: "docker",
  label: "docker",
  run: () => new Promise((resolve) => {
    execFile("docker", ["info"], (error) => resolve(error
      ? { ok: false, detail: "unavailable", hint: "start Docker Desktop" }
      : { ok: true }));
  }),
};

const mysqlCheck: PreflightCheck = {
  id: "mysql",
  label: "mysql",
  async run() {
    return await localMysqlIsRunning()
      ? { ok: true }
      : { ok: false, detail: "unavailable", hint: "pnpm dev:den:mysql" };
  },
};

const redisCheck: PreflightCheck = {
  id: "redis",
  label: "redis",
  async run() {
    return await localRedisIsRunning()
      ? { ok: true }
      : {
          ok: false,
          detail: "unavailable",
          hint: "start Redis on 127.0.0.1:6379 (Den worlds stall at sign-in without it)",
        };
  },
};

export { parseWorldArgs };

function isEphemeralDatabaseName(name: string): boolean {
  const prefix = "openwork_eval_";
  if (!name.startsWith(prefix)) return false;
  const suffix = name.slice(prefix.length);
  if (suffix.length < 1 || suffix.length > 60) return false;
  for (const character of suffix) {
    const code = character.charCodeAt(0);
    const lower = code >= 97 && code <= 122;
    const digit = code >= 48 && code <= 57;
    if (!lower && !digit && character !== "_") return false;
  }
  return true;
}

const dropEphemeralDatabase: Reaper = async (entry) => {
  if (!isEphemeralDatabaseName(entry.id)) {
    return { status: "skipped", reason: "outside allowed names" };
  }
  try {
    const url = new URL(process.env.OPENWORK_EVAL_MYSQL_URL?.trim() || DEFAULT_MYSQL_URL);
    url.pathname = "/";
    const connection = await createConnection(url.toString());
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${entry.id}\``);
    } finally {
      await connection.end();
    }
    return { status: "reaped" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "skipped", reason: `mysql unavailable: ${message}` };
  }
};

export function main(argv = process.argv.slice(2)): Promise<number> {
  return runWorldCli(argv, {
    cwd: REPO_ROOT,
    worldsDirectory: WORLDS_DIRECTORY,
    preflight: [dockerCheck, mysqlCheck, redisCheck],
    reapers: { "mysql-db": dropEphemeralDatabase },
  });
}
