import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runtimeStorageDir } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { isRecord } from "./workspace-kv-store.js";

const STATE_FILE = "engine-system-proxy.json";

export function createEngineSystemProxy(config: Pick<ServerConfig, "configPath" | "engineSystemProxyEnv">) {
  const path = join(runtimeStorageDir(config), STATE_FILE);
  let wanted = false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    wanted = isRecord(parsed) && parsed.enabled === true;
  } catch {
  }
  const available = typeof config.engineSystemProxyEnv === "function";
  return {
    available,
    wanted: () => available && wanted,
    async env(): Promise<Record<string, string>> {
      if (!available || !wanted) return {};
      try {
        return await config.engineSystemProxyEnv?.() ?? {};
      } catch (error) {
        console.warn(`[openwork:system-proxy] relay unavailable; the engine connects directly: ${error instanceof Error ? error.message : String(error)}`);
        return {};
      }
    },
    async record(enabled: boolean | undefined): Promise<void> {
      if (enabled === undefined || enabled === wanted) return;
      wanted = enabled;
      await mkdir(runtimeStorageDir(config), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ enabled })}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    },
  };
}
