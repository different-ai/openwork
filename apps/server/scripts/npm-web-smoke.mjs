// Release smoke for an installed openwork-server npm package:
//   node npm-web-smoke.mjs <path-to-installed>/bin/openwork-server.mjs <expected-version>
// Runs `--version`, then `openwork-server web` against a fresh home directory
// (so the OpenCode engine is downloaded as on a user's first run) and checks
// the web UI, an authenticated API call, the engine proxy, the bundled
// engine plugins and session creation. Exits non-zero on the first failure.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [launcher, expectedVersion] = process.argv.slice(2);
if (!launcher || !expectedVersion) {
  console.error("usage: node npm-web-smoke.mjs <bin/openwork-server.mjs> <expected-version>");
  process.exit(2);
}

const READY_TIMEOUT_MS = 5 * 60_000;
const log = (message) => console.log(`[npm-web-smoke] ${message}`);
const fail = (message) => {
  throw new Error(message);
};

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function request(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  return { status: response.status, text };
}

function stopTree(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

const home = await mkdtemp(join(tmpdir(), "openwork-npm-home-"));
const workspace = await mkdtemp(join(tmpdir(), "openwork-npm-ws-"));
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  OPENWORK_PACKAGE_ROOT: "",
};

const version = spawnSync(process.execPath, [launcher, "--version"], { encoding: "utf8", env });
if (version.status !== 0) fail(`--version exited ${version.status}: ${version.stderr}`);
if (version.stdout.trim() !== expectedVersion) fail(`--version printed ${version.stdout.trim()}, expected ${expectedVersion}`);
log(`--version ${expectedVersion}`);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let output = "";
const child = spawn(process.execPath, [launcher, "web", "--port", String(port)], {
  cwd: workspace,
  env,
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
}

try {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!/OpenWork web UI: /.test(output)) {
    if (child.exitCode !== null) fail(`openwork-server web exited ${child.exitCode} before it was ready`);
    if (Date.now() > deadline) fail("openwork-server web was not ready within 5 minutes");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!/Installed OpenCode \S+ to /.test(output)) fail("the OpenCode engine was not downloaded on first run");

  const health = await request(`${base}/health`);
  if (health.status !== 200 || JSON.parse(health.text).version !== expectedVersion) {
    fail(`/health returned ${health.status}: ${health.text}`);
  }
  log("/health ok");

  const page = await request(`${base}/`);
  if (page.status !== 200 || !page.text.includes("<title>OpenWork</title>")) fail(`/ returned ${page.status}`);
  log("web UI served");

  const tokensPath = /Tokens: (.+)/.exec(output)?.[1]?.trim();
  if (!tokensPath || !existsSync(tokensPath)) fail(`token file not reported or missing: ${tokensPath}`);
  const { token } = JSON.parse(await readFile(tokensPath, "utf8"));
  const auth = { authorization: `Bearer ${token}` };

  const workspaces = await request(`${base}/workspaces`, { headers: auth });
  if (workspaces.status !== 200) fail(`/workspaces returned ${workspaces.status}`);
  const workspaceId = JSON.parse(workspaces.text).items?.[0]?.id;
  if (!workspaceId) fail("no workspace was created for the working directory");

  const config = await request(`${base}/workspace/${workspaceId}/opencode/config`, { headers: auth });
  if (config.status !== 200) fail(`engine config returned ${config.status}`);
  const plugins = JSON.parse(config.text).plugin ?? [];
  const missing = plugins.filter((entry) => {
    const spec = String(entry);
    return spec.startsWith("file:") && !existsSync(fileURLToPath(spec));
  });
  if (plugins.length === 0 || missing.length > 0) fail(`engine plugins missing: ${JSON.stringify(missing.length ? missing : plugins)}`);
  log(`engine loaded ${plugins.length} plugins from the package`);

  const created = await request(`${base}/workspace/${workspaceId}/opencode/session`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ title: "npm release smoke" }),
  });
  if (created.status !== 200 || !JSON.parse(created.text).id) fail(`session create returned ${created.status}: ${created.text}`);
  log("session created through the engine");
  log("passed");
} finally {
  stopTree(child);
}
process.exit(0);
