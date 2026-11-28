import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";

const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";
const legacyBinary = process.env.OPENWORK_TEST_OPENCODE1 ?? join(dirname(binary), "opencode");
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// An install that ran the V1 engine stored the provider's key in auth.json under
// the provider id. OpenCode 2 migrates that database in place and imports the
// file, so the engine holds a second, older key for the same provider.
test("a key imported from a V1 install never replaces the key OpenWork gives a provider", { timeout: 120_000 }, async t => {
  for (const path of [binary, legacyBinary]) {
    try { await access(path); } catch {
      t.skip(`needs: OpenCode V1 and V2 binaries (${path}); set OPENWORK_TEST_OPENCODE1 and OPENWORK_TEST_OPENCODE2`);
      return;
    }
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwork-provider-key-upgrade-")));
  const cleanup: Array<() => unknown> = [() => rm(root, { recursive: true, force: true })];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const directory = join(root, "project");
  await mkdir(directory);
  const env = {
    HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_DISABLE_MODELS_FETCH: "true",
  };
  const database = join(root, "data", "opencode", "opencode.db");

  const legacy = spawnSync(legacyBinary, ["session", "list"], { cwd: directory, env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8", timeout: 30_000 });
  assert.equal(legacy.status, 0, legacy.stderr);
  await writeFile(join(root, "data", "opencode", "auth.json"), JSON.stringify({ lpr_fixture: { type: "api", key: "key-saved-by-v1" } }));

  const seen: string[] = [];
  const upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const authorization = request.headers.authorization ?? "";
      seen.push(authorization);
      if (authorization !== "Bearer key-from-openwork") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Invalid key", type: "auth_error", code: "401" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: Record<string, unknown>, finish: string | null) => response.write(`data: ${JSON.stringify({
        id: "c1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      chunk({ role: "assistant", content: "ok" }, null);
      chunk({}, "stop");
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const address = upstream.address();
  assert.ok(record(address) && typeof address.port === "number");

  const engine = await createManagedOpencodeV2Server({ bin: binary, rootDir: join(root, "engine"), historyDatabase: database, env });
  cleanup.push(() => engine.close());
  await engine.setProviders([{
    id: "lpr_fixture", name: "Fixture", apiKey: "key-from-openwork", baseUrl: `http://127.0.0.1:${address.port}/v1`,
    package: "@opencode/ai/providers/openai-compatible", models: [{ id: "test-model", name: "Test model" }],
  }]);

  const created = await engine.fetchJson("/api/session", {
    method: "POST", directory, timeoutMs: 30_000,
    body: { title: "Upgraded install", model: { providerID: "lpr_fixture", id: "test-model" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] },
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.ok(record(created.json) && record(created.json.data) && typeof created.json.data.id === "string", JSON.stringify(created));
  const prompt = engine.fetchJson(`/api/session/${created.json.data.id}/prompt`, { method: "POST", directory, timeoutMs: 60_000, body: { text: "Say ok." } }).catch(() => undefined);
  for (let waited = 0; seen.length === 0 && waited < 60_000; waited += 100) await delay(100);
  await prompt;

  const imported = new DatabaseSync(database, { readOnly: true });
  const credentials = imported.prepare("SELECT integration_id FROM credential").all();
  imported.close();
  assert.deepEqual(credentials.map(row => row.integration_id), ["lpr_fixture"], "the engine imported the V1 key under the provider id");
  assert.equal(seen[0], "Bearer key-from-openwork");
});
