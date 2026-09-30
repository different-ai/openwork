import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { allocateFreePort } from "@openwork/cdp";
import { killLocalPid } from "@openwork/hosts";
import { trackResource } from "@openwork/world";
import mysql from "mysql2/promise";

export async function nativeMysql0097(options: { mysqld: string; pnpm: string }) {
  if (!isAbsolute(options.mysqld) || !isAbsolute(options.pnpm)) throw new Error("MySQL and pnpm paths must be absolute");
  const stack = new AsyncDisposableStack();
  try {
    const root = await mkdtemp(join(tmpdir(), "ow0097-"));
    stack.defer(() => rm(root, { recursive: true, force: true }));
    await trackResource({ kind: "tmpdir", id: root, label: "mysql-0097-native" });
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/pnpm"), `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${options.pnpm.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o700 });
    const env = { PATH: `${join(root, "bin")}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: process.env.HOME, TMPDIR: root, NODE_ENV: "test", pnpm_config_verify_deps_before_run: "false" };
    const data = join(root, "data");
    await mkdir(data);
    const password = randomBytes(24).toString("hex");
    const init = join(root, "init.sql");
    await writeFile(init, `ALTER USER 'root'@'localhost' IDENTIFIED BY '${password}';\n`, { mode: 0o600 });
    await promisify(execFile)(options.mysqld, ["--no-defaults", "--initialize-insecure", `--datadir=${data}`], { env, timeout: 120_000 });
    const port = await allocateFreePort();
    const child = spawn(options.mysqld, ["--no-defaults", `--datadir=${data}`, `--port=${port}`, "--bind-address=127.0.0.1", "--mysqlx=0", `--socket=${join(root, "s")}`, `--pid-file=${join(root, "mysql.pid")}`, `--log-error=${join(root, "mysql.log")}`, `--init-file=${init}`], { env, detached: true, stdio: "ignore" });
    let spawnError: Error | undefined;
    child.once("error", error => { spawnError = error; });
    const pid = child.pid;
    if (!pid) throw new Error("MySQL did not spawn");
    stack.defer(async () => { await killLocalPid(pid, { graceMs: 15_000 }); console.log("[mysql-0097] owned MySQL stopped; disposable data removed on exit"); });
    await trackResource({ kind: "process", id: String(pid), label: "mysql-0097-native", match: data });
    const url = `mysql://root:${password}@127.0.0.1:${port}/mysql`;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (spawnError) throw spawnError;
      try { const connection = await mysql.createConnection(url); await connection.end(); ready = true; break; } catch { await delay(500); }
      if (child.exitCode !== null) break;
    }
    if (!ready) throw new Error(await readFile(join(root, "mysql.log"), "utf8"));
    await rm(init);
    const admin = await mysql.createConnection(url);
    try {
      const [version] = await admin.query("SELECT @@version AS version");
      console.log("[mysql-0097] placement: local (explicit isolated native MySQL);", version);
    } finally { await admin.end(); }
    return { url, env, async [Symbol.asyncDispose]() { await stack.disposeAsync(); } };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
