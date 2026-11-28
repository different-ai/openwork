import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

const stateFs = { lstat, open, readdir };

export function createCloudCodingTurnRelease({
  base = "/tmp/openwork-cloud-coding",
  fetch: request = globalThis.fetch,
  fs = stateFs,
}: { base?: string; fetch?: typeof fetch; fs?: typeof stateFs } = {}) {
  const running = new Set<string>();
  async function releaseFile(path: string) {
    const file = await fs.open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) return;
      const state: unknown = JSON.parse(await file.readFile("utf8"));
      if (typeof state !== "object" || state === null || !("token" in state) || typeof state.token !== "string") return;
      if ("api" in state && typeof state.api === "string") {
        try {
          const url = new URL(`${state.api.replace(/\/+$/, "")}/v1/cloud-coding/gateway/release`);
          if (["http:", "https:"].includes(url.protocol)) {
            const response = await request(url, {
              method: "POST", headers: { Authorization: `Bearer ${state.token}` },
              signal: AbortSignal.timeout(5_000), redirect: "error",
            });
            await response.body?.cancel();
          }
        } catch {
        }
      }
      const updated = Buffer.from(JSON.stringify({ ...state, token: null }));
      await file.chmod(0o600);
      await file.truncate(0);
      await file.write(updated, 0, updated.length, 0);
    } finally {
      await file.close();
    }
  }
  return async (sessionID: string) => {
    const key = createHash("sha256").update(sessionID).digest("hex").slice(0, 16);
    if (running.has(key)) return;
    running.add(key);
    try {
      const directory = join(base, key);
      if (!(await fs.lstat(base)).isDirectory() || !(await fs.lstat(directory)).isDirectory()) return;
      const entries = await fs.readdir(directory, { withFileTypes: true });
      await Promise.all(entries.filter(entry => entry.isDirectory()).map(entry =>
        releaseFile(join(directory, entry.name, "state.json")).catch(() => undefined)));
    } catch {
    } finally {
      running.delete(key);
    }
  };
}
