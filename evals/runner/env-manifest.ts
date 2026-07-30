import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DenServiceHandle, SurfaceHandle, SurfaceKind } from "./hosts/types.ts";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));

export interface EnvManifest {
  name: string;
  createdAt: string;
  defaultHostKind: string;
  den?: DenServiceHandle & { token?: string };
  surfaces: Record<string, SurfaceHandle>;
  env?: Record<string, string>;
}

function manifestFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Env manifest name cannot be empty.");
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`Env manifest name must not include path separators: ${name}`);
  }
  return `${trimmed}.json`;
}

export function manifestPath(name: string): string {
  return join(RUNNER_DIR, "..", "results", ".envs", manifestFileName(name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSurfaceKind(value: unknown): value is SurfaceKind {
  return value === "electron" || value === "chrome";
}

function isOrgMode(value: unknown): value is "single_org" | "multi_org" {
  return value === "single_org" || value === "multi_org";
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return null;
    result[key] = entry;
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function surfaceHandleFromUnknown(value: unknown): SurfaceHandle | null {
  if (!isRecord(value)) return null;
  if (typeof value.name !== "string" || !isSurfaceKind(value.kind) || typeof value.hostKind !== "string" || typeof value.cdpUrl !== "string") {
    return null;
  }
  const meta = value.meta === undefined ? undefined : stringRecord(value.meta);
  if (value.meta !== undefined && !meta) return null;
  const handle: SurfaceHandle = {
    name: value.name,
    kind: value.kind,
    hostKind: value.hostKind,
    cdpUrl: value.cdpUrl,
  };
  if (typeof value.pid === "number") handle.pid = value.pid;
  const profileDir = optionalString(value.profileDir);
  if (profileDir !== undefined) handle.profileDir = profileDir;
  const sandboxId = optionalString(value.sandboxId);
  if (sandboxId !== undefined) handle.sandboxId = sandboxId;
  if (meta) handle.meta = meta;
  return handle;
}

function denHandleFromUnknown(value: unknown): (DenServiceHandle & { token?: string }) | null {
  if (!isRecord(value)) return null;
  if (typeof value.webUrl !== "string" || typeof value.apiUrl !== "string" || !isOrgMode(value.orgMode) || typeof value.hostKind !== "string") {
    return null;
  }
  const handle: DenServiceHandle & { token?: string } = {
    webUrl: value.webUrl,
    apiUrl: value.apiUrl,
    orgMode: value.orgMode,
    hostKind: value.hostKind,
  };
  const token = optionalString(value.token);
  if (token !== undefined) handle.token = token;
  return handle;
}

function manifestFromUnknown(value: unknown): EnvManifest {
  if (!isRecord(value)) throw new Error("Env manifest JSON must be an object.");
  if (typeof value.name !== "string" || typeof value.createdAt !== "string" || typeof value.defaultHostKind !== "string") {
    throw new Error("Env manifest must include string name, createdAt, and defaultHostKind fields.");
  }
  if (!isRecord(value.surfaces)) throw new Error("Env manifest surfaces must be an object.");
  const surfaces: Record<string, SurfaceHandle> = {};
  for (const [name, surfaceValue] of Object.entries(value.surfaces)) {
    const surface = surfaceHandleFromUnknown(surfaceValue);
    if (!surface) throw new Error(`Env manifest surface ${name} is invalid.`);
    surfaces[name] = surface;
  }
  const den = value.den === undefined ? undefined : denHandleFromUnknown(value.den);
  if (value.den !== undefined && !den) throw new Error("Env manifest den handle is invalid.");
  const env = value.env === undefined ? undefined : stringRecord(value.env);
  if (value.env !== undefined && !env) throw new Error("Env manifest env entries must be strings.");
  const manifest: EnvManifest = {
    name: value.name,
    createdAt: value.createdAt,
    defaultHostKind: value.defaultHostKind,
    surfaces,
  };
  if (den) manifest.den = den;
  if (env) manifest.env = env;
  return manifest;
}

export async function writeEnvManifest(manifest: EnvManifest): Promise<string> {
  const path = manifestPath(manifest.name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

export async function readEnvManifest(name: string): Promise<EnvManifest | null> {
  try {
    const text = await readFile(manifestPath(name), "utf8");
    const parsed: unknown = JSON.parse(text);
    return manifestFromUnknown(parsed);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function setIfMissing(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (value === undefined) return;
  if (env[key] === undefined) env[key] = value;
}

export function applyManifestToEnv(manifest: EnvManifest, env: NodeJS.ProcessEnv): void {
  if (manifest.den) {
    setIfMissing(env, "OPENWORK_EVAL_DEN_API_URL", manifest.den.apiUrl);
    setIfMissing(env, "OPENWORK_EVAL_DEN_WEB_URL", manifest.den.webUrl);
    setIfMissing(env, "OPENWORK_EVAL_DEN_TOKEN", manifest.den.token);
    if (manifest.den.orgMode === "multi_org") setIfMissing(env, "OPENWORK_EVAL_DEN_MULTI_ORG", "1");
  }
  for (const [key, value] of Object.entries(manifest.env ?? {})) {
    setIfMissing(env, key, value);
  }
}
