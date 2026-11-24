import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeStorageDir } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";

const JOURNEY_FILE = "free-auto-journey";
const ANALYTICS_FILE = "free-auto-analytics";

export async function readFreeAutoJourney(config: Pick<ServerConfig, "configPath">): Promise<string> {
  const fallback = randomBytes(32).toString("hex");
  const directory = runtimeStorageDir(config);
  const path = join(directory, JOURNEY_FILE);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path, fallback, { flag: "wx", mode: 0o600 }).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    });
    const value = (await readFile(path, "utf8")).trim();
    return /^[a-f0-9]{64}$/.test(value) ? value : fallback;
  } catch { return fallback; }
}

export async function readFreeAutoAnalyticsEnabled(config: Pick<ServerConfig, "configPath">): Promise<boolean> {
  try {
    return (await readFile(join(runtimeStorageDir(config), ANALYTICS_FILE), "utf8")).trim() === "enabled";
  } catch { return false; }
}

export async function writeFreeAutoAnalyticsEnabled(config: Pick<ServerConfig, "configPath">, enabled: boolean): Promise<void> {
  const directory = runtimeStorageDir(config);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, ANALYTICS_FILE), enabled ? "enabled" : "disabled", { mode: 0o600 });
  if (!enabled) await rm(join(directory, JOURNEY_FILE), { force: true });
}
