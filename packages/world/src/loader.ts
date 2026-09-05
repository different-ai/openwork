import { readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

export interface ScriptWorld {
  kind: "script";
  name: string;
  path: string;
}

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

  const available = (await discoverWorlds(options.worldsDirectory)).map((world) => world.name);
  throw new Error(`Unknown world script ${JSON.stringify(source)}. Available: ${available.join(", ") || "(none)"}.`);
}

export function displayWorldPath(path: string, cwd: string): string {
  const displayed = relative(cwd, path);
  return displayed.startsWith("..") ? path : displayed;
}
