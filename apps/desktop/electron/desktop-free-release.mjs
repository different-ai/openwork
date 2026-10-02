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

/**
 * The secret this build uses to tag free Auto proofs.
 *
 * Packaged builds carry a module generated at build time for their exact
 * version. Developer builds have none; with OPENWORK_DEV_MODE=1 they may use
 * OPENWORK_DEV_FREE_RELEASE_SECRET, which the gateway honours only in its own
 * developer mode. The secret is kept in this closure and never leaves the
 * Electron main process.
 *
 * @param {{ appVersion: string; environment?: NodeJS.ProcessEnv; importGenerated?: () => Promise<{ version?: unknown; reveal?: unknown; disabled?: unknown }> }} options
 * @returns {Promise<{ secret: Buffer | null; source: "release" | "dev" | null }>}
 */
export async function loadDesktopFreeReleaseSecret({ appVersion, environment = process.env, importGenerated = () => import(generatedPath) }) {
  let generated = null;
  try { generated = await importGenerated(); } catch { generated = null; }
  if (generated?.version === appVersion && generated.disabled === true) return { secret: null, source: null };
  const devSecret = environment.OPENWORK_DEV_MODE === "1" ? environment.OPENWORK_DEV_FREE_RELEASE_SECRET?.trim() ?? "" : "";
  if (devSecret.length >= 32) return { secret: Buffer.from(devSecret, "utf8"), source: "dev" };
  if (!generated || typeof generated.reveal !== "function" || generated.version !== appVersion) return { secret: null, source: null };
  const revealed = generated.reveal();
  if (!(revealed instanceof Uint8Array) || revealed.length !== 32) return { secret: null, source: null };
  return { secret: Buffer.from(revealed), source: "release" };
}
