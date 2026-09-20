import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  invalidateOpencodeModelsCache,
  resolveOpencodeModelsCacheDir,
  resolveOpencodeModelsCachePath,
} from "./opencode-models-cache.js";

const CATALOG_URL = "https://models.openworklabs.com/";
const CATALOG_DIGEST = "b7ece982dab5170ce670b355b8f4c295b8b13e8a";

async function makeCacheDir(): Promise<{ cacheHome: string; dir: string }> {
  const cacheHome = await mkdtemp(join(tmpdir(), "openwork-models-cache-"));
  const dir = join(cacheHome, "opencode");
  await mkdir(dir, { recursive: true });
  return { cacheHome, dir };
}

describe("resolveOpencodeModelsCachePath", () => {
  test("addresses the digest file the engine actually writes", () => {
    expect(resolveOpencodeModelsCachePath({
      modelsUrl: CATALOG_URL,
      env: { XDG_CACHE_HOME: "/cache" },
    })).toBe(`/cache/opencode/models-${CATALOG_DIGEST}.json`);
  });

  test("a trailing slash selects a different digest", () => {
    const withSlash = resolveOpencodeModelsCachePath({
      modelsUrl: CATALOG_URL,
      env: { XDG_CACHE_HOME: "/cache" },
    });
    const withoutSlash = resolveOpencodeModelsCachePath({
      modelsUrl: "https://models.openworklabs.com",
      env: { XDG_CACHE_HOME: "/cache" },
    });

    expect(withSlash).not.toBe(withoutSlash);
  });

  test("falls back to the home cache directory", () => {
    expect(resolveOpencodeModelsCacheDir({ env: { XDG_CACHE_HOME: "   " } }))
      .toBe(join(process.env.HOME ?? "", ".cache", "opencode"));
  });
});

describe("invalidateOpencodeModelsCache", () => {
  test("removes every catalog file so the next spawn refetches", async () => {
    const { cacheHome, dir } = await makeCacheDir();
    await writeFile(join(dir, `models-${CATALOG_DIGEST}.json`), "{}");
    await writeFile(join(dir, `models-${"a".repeat(40)}.json`), "{}");

    const result = await invalidateOpencodeModelsCache({ env: { XDG_CACHE_HOME: cacheHome } });

    expect(result.removed).toHaveLength(2);
    expect(await readdir(dir)).toEqual([]);
  });

  test("leaves unrelated engine cache entries in place", async () => {
    const { cacheHome, dir } = await makeCacheDir();
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "models-not-a-digest.json"), "{}");
    await writeFile(join(dir, `models-${CATALOG_DIGEST}.json`), "{}");

    const result = await invalidateOpencodeModelsCache({ env: { XDG_CACHE_HOME: cacheHome } });

    expect(result.removed).toEqual([`models-${CATALOG_DIGEST}.json`]);
    expect((await readdir(dir)).sort()).toEqual(["bin", "models-not-a-digest.json"]);
  });

  test("reports no removals when the engine has never cached a catalog", async () => {
    const cacheHome = await mkdtemp(join(tmpdir(), "openwork-models-cache-"));

    expect(await invalidateOpencodeModelsCache({ env: { XDG_CACHE_HOME: cacheHome } }))
      .toEqual({ removed: [] });
  });
});
