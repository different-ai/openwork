import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually, test } from "@openwork/testkit";
import { expect } from "vitest";
import { createManagedOpencodeServer } from "../../apps/server/src/managed-opencode";
import { invalidateOpencodeModelsCache } from "../../apps/server/src/opencode-models-cache";

const RELEASED_MODEL = "witness-v2-released";
const EXISTING_MODEL = "witness-v1";

function catalogPayload(modelIds: string[]): string {
  return JSON.stringify({
    "catalog-witness": {
      id: "catalog-witness",
      name: "Catalog witness",
      env: ["CATALOG_WITNESS_API_KEY"],
      npm: "@ai-sdk/openai",
      api: "https://witness.invalid/v1",
      models: Object.fromEntries(modelIds.map((id) => [id, {
        id,
        name: id,
        attachment: false,
        reasoning: false,
        tool_call: true,
        cost: { input: 0, output: 0 },
        limit: { context: 128_000, output: 8_000 },
      }])),
    },
  });
}

async function readCachedCatalog(cacheHome: string): Promise<{ file: string; body: string } | null> {
  const dir = join(cacheHome, "opencode");
  const entries = await readdir(dir).catch(() => [] as string[]);
  const file = entries.find((entry) => /^models-[0-9a-f]{40}\.json$/.test(entry));
  if (!file) return null;
  return { file, body: await readFile(join(dir, file), "utf8") };
}

// #4788: the engine caches the provider catalog on disk and reads it back on
// every spawn without revalidating it, so a model released upstream stays
// invisible no matter how often the engine restarts. This pins both halves:
// the restart that changes nothing, and the invalidation that does.
test("a released model reaches the engine only after the cached catalog is dropped", { timeout: 180_000 }, async ({ evidence }) => {
  const binary = process.env.OPENWORK_EVAL_OPENCODE_BIN_V1
    ?? join(import.meta.dirname, "../../apps/desktop/resources/sidecars", process.platform === "win32" ? "opencode.exe" : "opencode");

  const root = await mkdtemp(join(tmpdir(), "openwork-catalog-refetch-"));
  const cacheHome = join(root, "cache");
  const configPath = join(root, "opencode.json");
  await writeFile(configPath, JSON.stringify({}));

  let served = catalogPayload([EXISTING_MODEL]);
  const requestedPaths: string[] = [];
  const catalogHost = createServer((request, response) => {
    requestedPaths.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(served);
  });
  await new Promise<void>((resolve) => catalogHost.listen(0, "127.0.0.1", resolve));
  const address = catalogHost.address();
  if (address === null || typeof address === "string") throw new Error("catalog host did not bind a port");
  const catalogUrl = `http://127.0.0.1:${address.port}/`;

  const env = {
    HOME: root,
    OPENCODE_CONFIG: configPath,
    OPENCODE_MODELS_URL: catalogUrl,
    XDG_CONFIG_HOME: join(root, "xdg"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: cacheHome,
  };

  const bootEngine = async () => createManagedOpencodeServer({ bin: binary, cwd: root, env, timeoutMs: 120_000 });

  try {
    // 1. First boot writes the catalog the engine was served.
    const first = await bootEngine();
    const initial = await eventually(
      async () => await readCachedCatalog(cacheHome),
      { within: 60_000, intervalMs: 200, label: "the engine caches the catalog it fetched", until: (value) => value !== null },
    );
    await first.close();
    expect(initial).not.toBeNull();
    expect(initial?.body).toContain(EXISTING_MODEL);
    expect(initial?.body).not.toContain(RELEASED_MODEL);

    // 2. A new model is released upstream.
    served = catalogPayload([EXISTING_MODEL, RELEASED_MODEL]);

    const fetchesBeforeRestart = requestedPaths.length;
    expect(fetchesBeforeRestart).toBeGreaterThan(0);

    // 3. Restarting alone is not enough: the engine reads the pinned file and
    // never asks the catalog host whether anything changed.
    const second = await bootEngine();
    const afterRestart = await readCachedCatalog(cacheHome);
    const fetchesAfterRestart = requestedPaths.length;
    await second.close();
    expect(afterRestart?.body).not.toContain(RELEASED_MODEL);
    expect(fetchesAfterRestart).toBe(fetchesBeforeRestart);
    evidence.recordAssertionEvidence(
      "A restart alone leaves the released model invisible and revalidates nothing",
      `${RELEASED_MODEL} absent after a full engine restart; catalog host requests stayed at ${fetchesAfterRestart}`,
      afterRestart?.body.includes(RELEASED_MODEL) === false && fetchesAfterRestart === fetchesBeforeRestart,
    );

    // 4. Dropping the cache is what the refresh does.
    const invalidated = await invalidateOpencodeModelsCache({ env });
    expect(invalidated.removed).toEqual([initial?.file]);
    expect(await readCachedCatalog(cacheHome)).toBeNull();

    // 5. The replacement engine fetches the catalog again.
    const third = await bootEngine();
    const refreshed = await eventually(
      async () => await readCachedCatalog(cacheHome),
      { within: 60_000, intervalMs: 200, label: "the replacement engine refetches the catalog", until: (value) => value !== null },
    );
    await third.close();
    expect(refreshed?.body).toContain(RELEASED_MODEL);
    // The refetch is a real request, not a reread of something left on disk.
    expect(requestedPaths.length).toBeGreaterThan(fetchesAfterRestart);
    evidence.recordAssertionEvidence(
      "After the cache is dropped the released model reaches the engine",
      `refetched catalog lists ${RELEASED_MODEL}; catalog host requests rose `
        + `from ${fetchesAfterRestart} to ${requestedPaths.length}`,
      refreshed?.body.includes(RELEASED_MODEL) === true && requestedPaths.length > fetchesAfterRestart,
    );
  } finally {
    await new Promise<void>((resolve) => catalogHost.close(() => resolve()));
  }
});
