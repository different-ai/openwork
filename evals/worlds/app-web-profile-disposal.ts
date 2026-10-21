import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Seed } from "@openwork/env";

async function profileBytes(path: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) bytes += await profileBytes(child);
    else if (entry.isFile()) bytes += (await lstat(child)).size;
  }
  return bytes;
}

export async function appWebProfileDisposal(seed: Seed) {
  const app = await seed.appWeb({
    name: "profile-disposal", workspacePath: seed.tmpPath("profile-disposal"), engine: "v1", headless: true,
  });
  // This proof inspects local fixture lifecycle, not a remote sandbox's filesystem.
  if (app.handle.hostKind !== "local" || !app.handle.profileDir || !app.handle.meta?.log || !app.handle.pid) {
    throw new Error("Profile disposal proof requires the fixture's local Chrome launch receipt.");
  }
  const profileDir = app.handle.profileDir;
  const log = app.handle.meta.log;
  const pid = app.handle.pid;
  const beforeBytes = await profileBytes(profileDir);
  const beforeLog = await readFile(log, "utf8");
  return {
    app, beforeBytes,
    async finish() {
      // The same final fixture disposer registered by seed.appWeb, not a generic
      // browser stop/restart or a filesystem cleanup in the proof.
      await app[Symbol.asyncDispose]();
      const profileRemoved = await lstat(profileDir).then(() => false, (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
        throw error;
      });
      let browserStopped = false;
      try { process.kill(pid, 0); } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") browserStopped = true;
        else throw error;
      }
      const retainedLog = await readFile(log, "utf8");
      return { profileRemoved, browserStopped, logPreserved: retainedLog.startsWith(beforeLog), logBytes: Buffer.byteLength(retainedLog) };
    },
  };
}
