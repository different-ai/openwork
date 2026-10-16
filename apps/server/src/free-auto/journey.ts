import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeStorageDir } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";

const JOURNEY_FILE = "free-auto-journey";
/** The app's analytics choice, as last reported by the app. Missing means not yet reported: send nothing. */
const ANALYTICS_FILE = "free-auto-analytics";

/** Random analytics correlation only. It never authorizes requests or changes the IP-based guest allowance. */
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

/** True only after the app reported that analytics is on. Unreadable or absent state is treated as off. */
export async function readFreeAutoAnalyticsEnabled(config: Pick<ServerConfig, "configPath">): Promise<boolean> {
  try {
    return (await readFile(join(runtimeStorageDir(config), ANALYTICS_FILE), "utf8")).trim() === "enabled";
  } catch { return false; }
}

/**
 * Stores the app's analytics choice so it survives a server restart. Turning analytics off also deletes the journey,
 * so turning it back on starts a new identifier that cannot be linked to the old one.
 */
export async function writeFreeAutoAnalyticsEnabled(config: Pick<ServerConfig, "configPath">, enabled: boolean): Promise<void> {
  const directory = runtimeStorageDir(config);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, ANALYTICS_FILE), enabled ? "enabled" : "disabled", { mode: 0o600 });
  if (!enabled) await rm(join(directory, JOURNEY_FILE), { force: true });
}
