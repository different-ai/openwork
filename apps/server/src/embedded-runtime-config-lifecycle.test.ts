import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { startEmbeddedServer } from "./embedded.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";

const HOST = "127.0.0.1";
const SERVER_TOKEN = "server-token";
const HOST_TOKEN = "host-token";
const PROVIDER_ID = "lpr_anthropic";
const PROVIDER = { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"] };
const DEV_MODE_ENV = "OPENWORK_DEV_MODE";
const RUNTIME_DB_ENV = "OPENWORK_RUNTIME_DB";
const OPENCODE_BASE_URL_ENV = "OPENWORK_OPENCODE_BASE_URL";
const FIRST_WORKSPACE_DIR = "first-workspace";
const SECOND_WORKSPACE_DIR = "second-workspace";
const RUNTIME_DB_FILE = "runtime.sqlite";
const FIRST_CONFIG_FILE = "first-server.json";
const SECOND_CONFIG_FILE = "second-server.json";
const HTTP_OK = 200;
const PATCH_METHOD = "PATCH";
const CONTENT_TYPE = "application/json";
const SKIPPED = "skipped";
const STALE_MCP_URL = "https://stale.example.test/mcp";

function restoreProcessEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function writeFakeOpencodeBin(root: string): Promise<string> {
  const binPath = join(root, "fake-opencode.mjs");
  await writeFile(binPath, [
    "#!/usr/bin/env bun",
    "const portIndex = process.argv.indexOf(\"--port\");",
    "const requestedPort = Number(process.argv[portIndex + 1] ?? 0);",
    "const server = Bun.serve({ port: requestedPort, fetch: () => Response.json({ ok: true }) });",
    "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
    "process.on(\"SIGTERM\", () => { server.stop(true); process.exit(0); });",
  ].join("\n"));
  await chmod(binPath, 0o755);
  return binPath;
}

function hostHeaders(): Record<string, string> {
  return {
    "content-type": CONTENT_TYPE,
    "x-openwork-host-token": HOST_TOKEN,
  };
}

describe("embedded runtime config lifecycle", () => {
  test("stopped embedded servers cannot rewrite the active runtime config file", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-embedded-runtime-lifecycle-"));
    const previousDevMode = process.env[DEV_MODE_ENV];
    const previousRuntimeDb = process.env[RUNTIME_DB_ENV];
    const previousOpencodeBaseUrl = process.env[OPENCODE_BASE_URL_ENV];
    let activeHandle: Awaited<ReturnType<typeof startEmbeddedServer>> | null = null;

    try {
      const firstWorkspace = join(root, FIRST_WORKSPACE_DIR);
      const secondWorkspace = join(root, SECOND_WORKSPACE_DIR);
      await Promise.all([
        mkdir(firstWorkspace, { recursive: true }),
        mkdir(secondWorkspace, { recursive: true }),
      ]);
      const opencodeBin = await writeFakeOpencodeBin(root);
      process.env[DEV_MODE_ENV] = "1";
      process.env[RUNTIME_DB_ENV] = join(root, RUNTIME_DB_FILE);
      delete process.env[OPENCODE_BASE_URL_ENV];

      const stoppedHandle = await startEmbeddedServer({
        configPath: join(root, FIRST_CONFIG_FILE),
        host: HOST,
        port: 0,
        token: SERVER_TOKEN,
        hostToken: HOST_TOKEN,
        workspaces: [firstWorkspace],
        manageOpencode: true,
        opencodeBin,
        opencodeCwd: firstWorkspace,
      });
      await stoppedHandle.stop();

      activeHandle = await startEmbeddedServer({
        configPath: join(root, SECOND_CONFIG_FILE),
        host: HOST,
        port: 0,
        token: SERVER_TOKEN,
        hostToken: HOST_TOKEN,
        workspaces: [secondWorkspace],
        manageOpencode: true,
        opencodeBin,
        opencodeCwd: secondWorkspace,
      });

      const providerPatch = { provider: { [PROVIDER_ID]: PROVIDER } };
      const initialPatch = await fetch(`${activeHandle.url}/runtime-config/providers`, {
        method: PATCH_METHOD,
        headers: hostHeaders(),
        body: JSON.stringify(providerPatch),
      });
      expect(initialPatch.status).toBe(HTTP_OK);
      // The engine reload may be applied in place or deferred to a rollover;
      // either way the patch must not be reported as skipped.
      const initialBody = await initialPatch.json() as { changed: boolean; reload: string };
      expect(initialBody.changed).toBe(true);
      expect(initialBody.reload).not.toBe(SKIPPED);

      const stoppedWorkspace = stoppedHandle.config.workspaces[0];
      if (!stoppedWorkspace) throw new Error("Expected the stopped server workspace");
      await writeRuntimeOpencodeConfig(stoppedHandle.config, stoppedWorkspace.id, (current) => ({
        ...current,
        mcp: { stale: { type: "remote", url: STALE_MCP_URL } },
      }));

      const identicalPatch = await fetch(`${activeHandle.url}/runtime-config/providers`, {
        method: PATCH_METHOD,
        headers: hostHeaders(),
        body: JSON.stringify(providerPatch),
      });
      expect(identicalPatch.status).toBe(HTTP_OK);
      expect(await identicalPatch.json()).toMatchObject({ changed: false, reload: SKIPPED });
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        await activeHandle?.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
      restoreProcessEnv(DEV_MODE_ENV, previousDevMode);
      restoreProcessEnv(RUNTIME_DB_ENV, previousRuntimeDb);
      restoreProcessEnv(OPENCODE_BASE_URL_ENV, previousOpencodeBaseUrl);
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Failed to clean up embedded runtime config lifecycle test");
    }
  });
});
