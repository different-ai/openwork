import { readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

export interface ScriptWorld {
  kind: "script";
  name: string;
  path: string;
}

/**
 * Worlds that were renamed or moved out of `worlds/`. Asking for an old name
 * fails with the new one instead of silently starting something else.
 */
export const RENAMED_WORLDS: Readonly<Record<string, string>> = {
  "app-web": "preview-app-web",
  "dev-headless": "dev-app-web",
  "desktop-prod-live": "live-desktop",
  "headless-prod-live": "live-app-web",
  "solo": "preview-full --seed workspace",
  "evidence-web": "./packages/freestyle/worlds/evidence-web.ts",
  "acme-docs": "./evals/docs-shots/world.ts",
  "litellm-per-member": "./examples/litellm-per-member-keys/world.ts",
  "mysql-0097-native": "./ee/packages/den-db/test/mysql-0097-native.world.ts",
  "den-split-origin-kind": "./evals/worlds/den-split-origin-kind.world.ts",
  "remote-session": "./evals/worlds/infra/remote-session.ts",
  "cloud-model-infra": "./evals/worlds/infra/cloud-model-infra.ts",
  "cloud-model-infra-worker": "./evals/worlds/infra/cloud-model-infra-worker.ts",
  // Removed: nothing ran them; these cover the same ground.
  "acme-demo": "acme-web",
  "azure-byok": "preview-den",
  "gateway-local": "preview-den",
  "den-gateway-local": "preview-den",
  "cross-workspace-split-view": "preview-full --seed workspace",
};

export function worldScriptName(path: string): string {
  return basename(path, extname(path));
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((entry) => entry.isFile(), () => false);
}

export async function discoverWorlds(directory: string): Promise<ScriptWorld[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort()
    .map((name) => ({ kind: "script", name: worldScriptName(name), path: join(directory, name) }));
}

export async function resolveWorldScript(
  source: string,
  options: { cwd: string; worldsDirectory: string },
): Promise<ScriptWorld> {
  const pathLike = isAbsolute(source) || source.includes("/") || source.includes("\\");
  const requestedPath = pathLike
    ? resolve(options.cwd, source)
    : join(options.worldsDirectory, source.endsWith(".ts") ? source : `${source}.ts`);
  if (!requestedPath.endsWith(".ts")) {
    throw new Error(`World script ${JSON.stringify(source)} must be a TypeScript file.`);
  }
  if (await isFile(requestedPath)) {
    return { kind: "script", name: worldScriptName(requestedPath), path: requestedPath };
  }

  const renamed = pathLike ? undefined : RENAMED_WORLDS[source.replace(/\.ts$/, "")];
  if (renamed) throw new Error(`World ${JSON.stringify(source)} was renamed, moved or removed; use ${renamed}.`);
  const available = (await discoverWorlds(options.worldsDirectory)).map((world) => world.name);
  throw new Error(`Unknown world script ${JSON.stringify(source)}. Available: ${available.join(", ") || "(none)"}.`);
}

export function displayWorldPath(path: string, cwd: string): string {
  const displayed = relative(cwd, path);
  return displayed.startsWith("..") ? path : displayed;
}
