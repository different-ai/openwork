export const supportedTargets = ["local/host"];

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { nativeMysql0097 } from "../evals/packages/env/src/mysql-0097-native.ts";

export async function main() {
  const { values } = parseArgs({ options: {
    mysqld: { type: "string" }, pnpm: { type: "string" }, suite: { type: "string", default: "package" },
  } });
  if (process.env.OPENWORK_WORLD_PLACE !== "local") throw new Error("Use explicit --place local; this foreground-only world owns a disposable native MySQL instance.");
  if (!values.mysqld || !values.pnpm || !["package", "focused"].includes(values.suite)) throw new Error("Required: --mysqld <absolute binary> --pnpm <pnpm.cjs> [--suite package|focused]");
  const repo = fileURLToPath(new URL("..", import.meta.url));
  await using mysql = await nativeMysql0097({ mysqld: values.mysqld, pnpm: values.pnpm });
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const run = async (args: string[], cwd: string, env: NodeJS.ProcessEnv) => {
      const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit", signal: controller.signal });
      return await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); });
    };
    for (const pkg of ["@openwork/types", "@openwork-ee/den-db"]) {
      const build = await run([values.pnpm, "--filter", pkg, "build"], repo, mysql.env);
      if (build !== 0) throw new Error(`${pkg} build failed: exit ${build}`);
    }
    const db = join(repo, "ee/packages/den-db");
    const tests = values.suite === "focused" ? ["bootstrap-mysql-upgrade.test.ts"] : (await readdir(join(db, "test"))).filter(name => name.endsWith(".test.ts")).sort();
    process.exitCode = await run(["--conditions=development", "--import", "tsx", "--test", "--test-concurrency=1", ...tests.map(name => `test/${name}`)], db, { ...mysql.env, DEN_DB_MYSQL_TEST_URL: mysql.url, DEN_DB_MYSQL_ISOLATED: "1" });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

if (import.meta.main) await main();
