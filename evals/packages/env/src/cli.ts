import { fileURLToPath } from "node:url";
import { createConnection } from "mysql2/promise";
import { main as runWorldCli, parseWorldArgs, type Reaper } from "@openwork/world";
import { DEFAULT_MYSQL_URL } from "./place.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const WORLDS_DIRECTORY = fileURLToPath(new URL("../../../../worlds", import.meta.url));

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
    reapers: { "mysql-db": dropEphemeralDatabase },
  });
}
