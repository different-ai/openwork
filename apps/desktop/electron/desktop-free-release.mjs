import path from "node:path";
import { fileURLToPath } from "node:url";

const generatedPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "generated", "desktop-free-release.mjs");

/**
 * Keep an explicit build-time opt-out effective after installation, without
 * requiring people to set environment variables on every desktop launch.
 * @param {{ appVersion: string; environment?: NodeJS.ProcessEnv; importGenerated?: () => Promise<{ version?: unknown; disabled?: unknown }> }} options
 */
export async function applyDesktopFreeBuildSettings({ appVersion, environment = process.env, importGenerated = () => import(generatedPath) }) {
  let generated = null;
  try { generated = await importGenerated(); } catch { return false; }
  if (generated?.version !== appVersion || generated.disabled !== true) return false;
  environment.OPENWORK_DISABLE_FREE_INFERENCE = "1";
  return true;
}
