import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";
import { createV2ProviderSessionBridge } from "../src/opencode-v2-provider-session.js";

const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  let latest: T | undefined;
  for (let i = 0; i < 400; i++) {
    latest = await read();
    if (accept(latest)) return latest;
    await delay(50);
  }
  throw new Error(`${label}: ${JSON.stringify(latest)}`);
}

// Unlike a child_process mock, this exercises the pinned engine's own native
// model -> approved shell -> Bun subprocess path, before live ownership starts.
test("native model-approved shells cannot redeem the desktop capability before or after late live activation", { timeout: 90_000 }, async t => {
  try { await access(binary); } catch {
    t.skip(`needs: pinned OpenCode 2.0.26 binary (${binary}); set OPENWORK_TEST_OPENCODE2`);
    return;
  }
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  assert.match(version.stdout, /\bv2\.0\.26\b/);
  const root = await mkdtemp(join(tmpdir(), "openwork-private-provider-"));
  const home = join(root, "home");
  await mkdir(home);
  const project = join(root, "project");
  await mkdir(project);
  const directory = await realpath(project);
  let phase = "initial";
  let toolCalls = 0;
  let modelError = "";
  const model = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ inferenceProviders: [] }));
      return;
    }
    let text = "";
    for await (const chunk of req) text += String(chunk);
    const body: unknown = JSON.parse(text);
    assert.ok(record(body));
    const messages = Array.isArray(body.messages) ? body.messages.filter(record) : [];
    const tools = Array.isArray(body.tools) ? body.tools.filter(record) : [];
    const shell = tools.map(tool => tool.function).filter(record).find(tool => tool.name === "bash" || tool.name === "shell");
    const hasResult = messages.some(message => message.role === "tool");
    const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "private-boundary", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (!hasResult && shell) {
      toolCalls++;
      const command = `node '${join(project, "inspect.mjs")}' '${phase}'`;
      const parameters = { command, description: "Inspect inherited credential boundary", timeout: 5000 };
      res.end(frame({ role: "assistant", tool_calls: [{ index: 0, id: `call_${phase}`, type: "function", function: { name: shell.name, arguments: JSON.stringify(parameters) } }] }) + frame({}, "tool_calls") + "data: [DONE]\n\n");
    } else {
      if (!hasResult) modelError = `No native shell: ${JSON.stringify(tools)}`;
      res.end(frame({ role: "assistant", content: "Boundary inspected" }) + frame({}, "stop") + "data: [DONE]\n\n");
    }
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const address = model.address();
  assert.ok(address && typeof address !== "string");
  const modelUrl = `http://127.0.0.1:${address.port}`;
  let handoffs = 0;
  const denToken = "native-boundary-den-session";
  const bridge = await createV2ProviderSessionBridge(() => {
    handoffs++;
    return { baseUrl: modelUrl, token: denToken, orgId: "org_security" };
  });
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  try {
    engine = await createManagedOpencodeV2Server({ bin: binary, rootDir: join(root, "engine"),
      env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "true" },
      providerSession: { ...bridge } });
    await engine.injectProvider({ id: "private_boundary", name: "Boundary fixture", apiKey: "fixture-model-key", baseUrl: `${modelUrl}/v1`,
      models: [{ id: "boundary", name: "Boundary fixture", config: { limit: { context: 8192, output: 1024 }, tool_call: true } }] });
    await writeFile(join(project, "inspect.mjs"), `
      import { readFileSync, writeFileSync, fstatSync, readSync } from "node:fs";
      const report = { envToken: process.env.OPENWORK_PROVIDER_SESSION_TOKEN || "", procTokens: [], fdText: "", fdReadable: false, status: 0 };
      if (process.platform === "linux") {
        for (const pid of ["self", ${JSON.stringify(String(engine.childPid))}]) {
          const raw = readFileSync('/proc/' + pid + '/environ', 'utf8');
          report.procTokens.push(...raw.split('\\0').filter(v => v.startsWith('OPENWORK_PROVIDER_SESSION_TOKEN=')));
        }
      }
      try {
        const stat = fstatSync(3);
        if (stat.isFIFO() || stat.isSocket()) {
          const bytes = Buffer.alloc(8192);
          const count = readSync(3, bytes);
          report.fdReadable = true;
          report.fdText = bytes.subarray(0, count).toString();
        }
      } catch {}
      const response = await fetch(${JSON.stringify(bridge.url)}, { headers: { authorization: 'Bearer ' + report.envToken }, signal: AbortSignal.timeout(2000) });
      report.status = response.status;
      writeFileSync(${JSON.stringify(join(project, "report-"))} + process.argv[2] + '.json', JSON.stringify(report));
      console.log('native-boundary-inspected');
    `);
    const initialConfig = await readFile(join(root, "engine/config/opencode.json"), "utf8");
    assert.ok(initialConfig.includes('"desktopSession"'));
    assert.ok(!initialConfig.includes(bridge.token));
    assert.ok(!initialConfig.includes(denToken));
    for (const nextPhase of ["initial", "reloaded"]) {
      phase = nextPhase;
      if (nextPhase === "reloaded") {
        await engine.refreshConfig();
      }
      await until(() => engine!.fetchJson("/api/model", { directory }), value => JSON.stringify(value.json).includes('"id":"boundary"'), "fixture model ready");
      const created = await engine.fetchJson("/api/session", { method: "POST", body: { title: `Security ${phase}`, location: { directory },
        model: { providerID: "private_boundary", id: "boundary" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] } });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      assert.ok(record(created.json) && record(created.json.data) && typeof created.json.data.id === "string");
      const sessionID = created.json.data.id;
      const prompted = await engine.fetchJson(`/api/session/${sessionID}/prompt`, { method: "POST", body: { text: "Inspect the credential boundary with the shell tool." } });
      assert.equal(prompted.status, 200, JSON.stringify(prompted.json));
      const report = await until(async () => {
        const text = await readFile(join(project, `report-${phase}.json`), "utf8").catch(() => "");
        if (!text && modelError) throw new Error(modelError);
        return text;
      }, Boolean, `actual engine shell report (${phase})`);
      const value: unknown = JSON.parse(report);
      assert.ok(record(value));
      assert.equal(value.envToken, "");
      assert.deepEqual(value.procTokens, []);
      assert.equal(value.fdReadable, false, "native Bun tool subprocess has no readable inherited credential descriptor");
      assert.equal(value.fdText, "", "native Bun tool subprocess did not inherit the unread capability pipe");
      assert.equal(value.status, 401, "a model-approved shell cannot redeem the Den-session bridge");
      assert.ok(!report.includes(bridge.token));
      assert.ok(!report.includes(denToken));
      await until(async () => handoffs, value => value > 0, "setup and reload use the private channel broker");
    }
    assert.equal(toolCalls, 2, "both witnesses were emitted by the model and executed by native tools");
  } finally {
    await engine?.close();
    await bridge.close();
    model.closeAllConnections();
    await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
