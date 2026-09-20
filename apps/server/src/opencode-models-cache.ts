import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// The engine writes the provider catalog to
// `$XDG_CACHE_HOME/opencode/models-<sha1 of the catalog URL>.json` and reads
// that file back on every spawn without revalidating it. A restart therefore
// never picks up a model released after the file was written; deleting the
// file is what makes the next spawn refetch the catalog.
const MODELS_CACHE_FILE = /^models-[0-9a-f]{40}\.json$/;

type ModelsCacheEnvOptions = {
  env?: NodeJS.ProcessEnv;
};

type ModelsCachePathOptions = ModelsCacheEnvOptions & {
  modelsUrl: string;
};

export function resolveOpencodeModelsCacheDir(options: ModelsCacheEnvOptions = {}): string {
  const env = options.env ?? process.env;
  const cacheHome = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cacheHome, "opencode");
}

export function resolveOpencodeModelsCachePath(options: ModelsCachePathOptions): string {
  const digest = createHash("sha1").update(options.modelsUrl).digest("hex");
  return join(resolveOpencodeModelsCacheDir(options), `models-${digest}.json`);
}

// Every catalog URL the engine has been spawned with leaves its own digest
// file, and the v1 and v2 spawn paths disagree about the URL's trailing slash.
// Removing every catalog file keeps a refresh from silently no-opping against a
// digest the caller did not predict.
export async function invalidateOpencodeModelsCache(
  options: ModelsCacheEnvOptions = {},
): Promise<{ removed: string[] }> {
  const dir = resolveOpencodeModelsCacheDir(options);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // No cache directory means nothing is pinning a stale catalog.
    return { removed: [] };
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (!MODELS_CACHE_FILE.test(entry)) continue;
    await rm(join(dir, entry), { force: true });
    removed.push(entry);
  }

  return { removed };
}
