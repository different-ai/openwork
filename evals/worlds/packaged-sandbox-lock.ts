import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./packaged-sandbox-fixtures.ts";

export async function acquirePackagedSandboxLock(caseName: string, signal?: AbortSignal) {
  const lock = "/tmp/ow-e2e-lock";
  const owner = `${caseName} pid=${process.pid} ${randomUUID()}\n`;
  for (;;) {
    signal?.throwIfAborted();
    try { await mkdir(lock); }
    catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      const info = await lstat(lock).catch(() => undefined);
      if (info?.isDirectory() && Date.now() - info.mtimeMs > 45 * 60_000) {
        const stale = `${lock}.stale-${randomUUID()}`;
        if (await rename(lock, stale).then(() => true, () => false)) await rm(stale, { recursive: true, force: true });
      }
      await delay(5000, undefined, { signal });
      continue;
    }
    try { await writeFile(`${lock}/owner`, owner, { flag: "wx" }); }
    catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
    return async () => {
      if (await readFile(`${lock}/owner`, "utf8").catch(() => "") === owner) await rm(lock, { recursive: true, force: true });
    };
  }
}
