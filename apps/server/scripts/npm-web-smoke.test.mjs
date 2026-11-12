import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const smoke = fileURLToPath(new URL("./npm-web-smoke.mjs", import.meta.url));
const version = "0.18.65";

test("recovery uses the workflow's smoke script while package sources stay pinned to the release", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/release-macos-aarch64.yml", import.meta.url), "utf8");
  const verification = workflow.slice(workflow.indexOf("  verify-npm-hosts:"), workflow.indexOf("  publish-npm:"));
  assert.match(verification, /name: Checkout smoke script[\s\S]*?ref: \$\{\{ github\.sha \}\}/);
  const preparation = workflow.slice(workflow.indexOf("  prepare-npm:"), workflow.indexOf("  verify-npm-hosts:"));
  assert.match(preparation, /RELEASE_TAG: \$\{\{ needs\.resolve-release\.outputs\.release_tag \}\}/);
  assert.match(preparation, /ref: \$\{\{ env\.RELEASE_TAG \}\}/);
});

test("snapshot recovery has its own concurrency namespace, not the caller's workflow name", async () => {
  const snapshot = await readFile(new URL("../../../.github/workflows/release-daytona-snapshot.yml", import.meta.url), "utf8");
  const concurrency = snapshot.slice(snapshot.indexOf("\nconcurrency:"), snapshot.indexOf("\njobs:"));
  assert.match(concurrency, /group: release-daytona-snapshot-\$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
  assert.match(concurrency, /cancel-in-progress: false/);
  // github.workflow is "Release App" inside a workflow_call too. In recovery,
  // both inputs.tag values are v0.18.65; using github.workflow would deadlock.
  assert.doesNotMatch(concurrency, /group:.*github\.workflow/);
});

// Run the release smoke itself, not a copy of its request logic. This launcher
// replaces only the installed package and its engine, without downloading either.
const launcherSource = String.raw`
import { createServer } from "node:http";
import { appendFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const record = (event) => appendFileSync(process.env.SMOKE_TEST_EVENTS, JSON.stringify(event) + "\n");
record({
  type: "launch",
  command: process.argv[2],
  home: process.env.HOME,
  state: process.env.XDG_STATE_HOME,
  db: process.env.OPENCODE_DB ?? null,
  config: process.env.OPENCODE_CONFIG_DIR ?? null,
  workspace: process.cwd(),
});
if (process.argv[2] === "--version") {
  console.log("0.18.65");
  process.exit(0);
}
if (process.argv[2] !== "web") process.exit(2);

const token = "npm-smoke-test-token";
const tokensPath = join(process.env.HOME, "tokens.json");
const pluginPath = join(process.env.HOME, "mock-plugin.mjs");
writeFileSync(tokensPath, JSON.stringify({ token }));
writeFileSync(pluginPath, "export default {};\n");
let statusRequests = 0;
let ready = false;
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : null;
  record({ type: "request", method: req.method, path: req.url, body });
  const send = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req.method === "GET" && req.url === "/health") return send(200, { version: "0.18.65" });
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<!doctype html><title>OpenWork</title>");
  }
  if (req.headers.authorization !== "Bearer " + token) return send(401, { error: "missing token" });
  if (req.method === "GET" && req.url === "/workspaces") return send(200, { items: [{ id: "ws-smoke" }] });
  if (req.method === "GET" && req.url === "/workspace/ws-smoke/opencode/config") {
    return send(200, { plugin: [pathToFileURL(pluginPath).href] });
  }
  if (req.method === "GET" && req.url === "/experimental/engine-v2-preview/status") {
    // The first poll sees an engine which is still starting.
    ready = ++statusRequests > 1;
    return send(200, { running: ready, chatRouting: ready });
  }
  if (req.method === "POST" && req.url === "/workspace/ws-smoke/opencode/session") {
    return send(409, { error: "legacy session writes are disabled" });
  }
  if (req.method === "POST" && req.url === "/workspace/ws-smoke/opencode2/api/session") {
    if (!ready) return send(409, { error: "engine is not ready" });
    if (body?.title !== "npm release smoke" || !body?.location?.directory || realpathSync(body.location.directory) !== process.cwd()) {
      return send(400, { error: "native session requires the workspace location" });
    }
    if (process.env.SMOKE_TEST_MODE === "create-failure") {
      // Even an id in an error response must not be accepted as success.
      return send(503, { data: { id: "session-smoke" } });
    }
    return send(200, { data: { id: "session-smoke" } });
  }
  if (req.method === "GET" && req.url === "/workspace/ws-smoke/opencode2/api/session/session-smoke") {
    const id = process.env.SMOKE_TEST_MODE === "readback-mismatch" ? "another-session" : "session-smoke";
    return send(200, { data: { id } });
  }
  return send(404, { error: "unexpected smoke request" });
});
server.listen(Number(process.argv[process.argv.indexOf("--port") + 1]), "127.0.0.1", () => {
  console.log("Installed OpenCode test to " + process.env.HOME);
  console.log("Prepared OpenCode plugin dependencies in " + process.env.HOME);
  console.log("Tokens: " + tokensPath);
  console.log("OpenWork web UI: http://127.0.0.1:" + server.address().port);
});
`;

async function runSmoke(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), "openwork-npm-smoke-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const launcher = join(directory, "launcher.mjs");
  const eventsPath = join(directory, "events.jsonl");
  await writeFile(launcher, launcherSource);
  const result = spawnSync(process.execPath, [smoke, launcher, version], {
    encoding: "utf8",
    timeout: 25_000,
    env: {
      ...process.env,
      SMOKE_TEST_EVENTS: eventsPath,
      SMOKE_TEST_MODE: mode,
      OPENCODE_DB: "inherited-db-must-not-leak",
      OPENCODE_CONFIG_DIR: "inherited-config-must-not-leak",
    },
  });
  const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const launches = events.filter((event) => event.type === "launch");
  // The smoke owns these fresh directories, but does not remove them itself.
  for (const home of new Set(launches.map((event) => event.home))) {
    t.after(() => rm(home, { recursive: true, force: true }));
  }
  const web = launches.find((event) => event.command === "web");
  if (web) t.after(() => rm(web.workspace, { recursive: true, force: true }));
  assert.ifError(result.error);
  return { result, events, launches, output: result.stdout + result.stderr };
}

const nativePath = "/workspace/ws-smoke/opencode2/api/session";
const requests = (events) => events.filter((event) => event.type === "request");

function assertNoLegacyWrites(events) {
  assert.equal(requests(events).some((event) => event.method === "POST" && event.path === "/workspace/ws-smoke/opencode/session"), false);
}

test("npm release smoke waits for v2, creates a native session and reads it back in an isolated home", async (t) => {
  const { result, events, launches, output } = await runSmoke(t, "success");
  assert.equal(result.status, 0, output);
  assert.match(output, /\[npm-web-smoke\] passed/);
  assert.deepEqual(launches.map((event) => event.command), ["--version", "web"]);
  for (const launch of launches) {
    assert.equal(launch.db, null, "inherited OPENCODE_DB reached the launcher");
    assert.equal(launch.config, null, "inherited OPENCODE_CONFIG_DIR reached the launcher");
    assert.equal(launch.state, join(launch.home, ".local", "state"));
  }
  const calls = requests(events);
  assert.ok(calls.some((event) => event.path === "/workspace/ws-smoke/opencode/config"), "legacy plugin config must still be checked");
  const polls = calls.filter((event) => event.path === "/experimental/engine-v2-preview/status");
  assert.ok(polls.length >= 2, "must wait beyond the starting status");
  const createIndex = calls.findIndex((event) => event.method === "POST" && event.path === nativePath);
  const readIndex = calls.findIndex((event) => event.method === "GET" && event.path === nativePath + "/session-smoke");
  assert.ok(createIndex > calls.lastIndexOf(polls.at(-1)), "creation must follow readiness");
  assert.ok(readIndex > createIndex, "created session must be read back");
  assert.equal(calls[createIndex].body.title, "npm release smoke");
  assert.equal(await realpath(calls[createIndex].body.location.directory), launches.find((event) => event.command === "web").workspace);
  assertNoLegacyWrites(events);
});

test("npm release smoke fails when native session creation is non-200", async (t) => {
  const { result, events, output } = await runSmoke(t, "create-failure");
  assert.notEqual(result.status, 0, output);
  assert.match(output, /503/);
  assert.doesNotMatch(output, /\[npm-web-smoke\] passed/);
  assert.ok(requests(events).some((event) => event.method === "POST" && event.path === nativePath));
  assert.equal(requests(events).some((event) => event.method === "GET" && event.path === nativePath + "/session-smoke"), false);
  assertNoLegacyWrites(events);
});

test("npm release smoke fails when native session readback returns a different id", async (t) => {
  const { result, events, output } = await runSmoke(t, "readback-mismatch");
  assert.notEqual(result.status, 0, output);
  assert.doesNotMatch(output, /\[npm-web-smoke\] passed/);
  assert.ok(requests(events).some((event) => event.method === "GET" && event.path === nativePath + "/session-smoke"), output);
  assertNoLegacyWrites(events);
});
