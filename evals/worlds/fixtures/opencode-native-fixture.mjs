// Self-contained: uploaded verbatim to the browser host, never imported from its checkout.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = "2.0.26";
const BUILDS = {
  "darwin-arm64": "sha512-XklldeO6eWgG8vkPNLcdlBPEm1Y+/tyhEXGZvXbk8uytpPP7SEVV2R9oZ98NMSSPH9kBAO/+Xo4sKfvD6CHAsw==",
  "darwin-x64": "sha512-051fIryTH4FK4Ml63TH+IP3s7Mi+jYfVyEXSBh9aGDJUS2VZfD+AwNJ9Ew9nBPTBKYvhMGhqHcudHagRL8SBbQ==",
  "linux-x64": "sha512-UIA2/1Ik8HaN54C4xp7H+OHgRfq995XUixrX+kLmFs8EPn1fAcmn3OoiN+3c3Vc3jEV/LHmj0Cy1SL6nW4wdGw==",
  "linux-arm64": "sha512-IG316I8wVqndohzFAoWNeH83eMA8sKQFRtMeuk2Wfg4DU1haCSgzAJz3/gbytjwh6bXdWR7V3FCSrfjoraKDgw==",
};
function object(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a fixture object");
  return value;
}
function string(value) {
  if (typeof value !== "string" || !value) throw new Error("Expected a fixture string");
  return value;
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid fixture integer");
  return value;
}
function plain(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}
const root = string(process.env.NATIVE_FIXTURE_ROOT);
const token = string(process.env.NATIVE_FIXTURE_TOKEN);
const upstreamBase = new URL(string(process.env.NATIVE_FIXTURE_DEN_API));
if (!["http:", "https:"].includes(upstreamBase.protocol)) throw new Error("Invalid Den API origin");
const platform = `${process.platform}-${process.arch}`;
if (process.env.NATIVE_FIXTURE_HOST_KIND === "daytona" && platform !== "linux-x64") throw new Error("Daytona native proof must run the pinned Linux x64 binary");
const home = join(root, "home");
const children = new Set();
const logins = new Map();
let binary;
let serviceConfigured = false;
let proxy;
let initialized;
let stopping;
let throttleNextTokenPoll = false;
let observeTokenPollFault = false;
let runnerOffline = false;
let disconnectAfterCompletion = false;
const tokenPollFault = { injected: 0, http429s: 0, authorizations: 0, retriedPolls: 0 };
const runnerRequests = [];
const runnerFault = { lostCompletionResponses: 0, refusedRequests: 0 };
const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && /^(PATH|LANG|LC_.*|SHELL|USER|TMPDIR|TMP|TEMP|DISPLAY|XAUTHORITY|SYSTEMROOT)$/.test(name)));
Object.assign(env, {
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
});

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind loopback");
  return address.port;
}
async function close(server) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function install() {
  const integrity = BUILDS[platform];
  if (!integrity) throw new Error(`No OpenCode ${VERSION} build pinned for ${platform}`);
  const directory = join(root, "binary");
  mkdirSync(directory, { recursive: true });
  // Every fixture is private and fresh; do not accept an unverified cached binary.
  const name = `cli-${platform}`;
  const response = await fetch(`https://registry.npmjs.org/@opencode/${name}/-/${name}-${VERSION}.tgz`, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Downloading OpenCode failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity) throw new Error(`OpenCode tarball integrity mismatch for ${platform}`);
  const archive = join(directory, "opencode.tgz");
  writeFileSync(archive, bytes);
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", directory], { encoding: "utf8", timeout: 30_000 });
  if (extracted.status !== 0) throw new Error(`Extracting OpenCode failed: ${extracted.stderr}`);
  binary = join(directory, "package", "bin", "opencode");
  chmodSync(binary, 0o755);
  return integrity;
}
function run(args, timeoutMs = 120_000) {
  if (!binary) throw new Error("Native fixture is not initialized");
  if (!Array.isArray(args) || !args.every(arg => typeof arg === "string")) throw new Error("Invalid native CLI arguments");
  integer(timeoutMs, 1, 180_000);
  return new Promise((done, fail) => {
    const child = spawn(binary, args, { env, cwd: home });
    children.add(child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", fail);
    child.once("close", status => {
      clearTimeout(timer);
      children.delete(child);
      // A denied login is data, not a failing sandbox shell command.
      done({ status, stdout: plain(stdout), stderr: plain(stderr) });
    });
  });
}
async function nativeInfo() {
  const result = await run(["api", "get", "/api/info"]);
  if (result.status !== 0) throw new Error(`Native info failed: ${result.stdout}${result.stderr}`);
  const info = object(JSON.parse(result.stdout));
  integer(info.pid, 1, Number.MAX_SAFE_INTEGER);
  if (info.version !== VERSION) throw new Error("Native service version mismatch");
  return info;
}
function startProxy() {
  return createServer((request, response) => {
    const upstreamUrl = new URL(`${upstreamBase.origin}${request.url ?? "/"}`);
    const tokenPoll = request.method === "POST" && upstreamUrl.pathname === "/api/auth/device/token";
    const runnerRequest = /^\/v1\/(session-runners|remote-session-commands|remote-session-requests)(\/|$)/.test(upstreamUrl.pathname);
    if (runnerRequest && runnerOffline) {
      runnerFault.refusedRequests++;
      runnerRequests.push({ method: request.method ?? "GET", path: upstreamUrl.pathname, status: 503 });
      request.resume();
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "synthetic_runner_link_offline" }));
      return;
    }
    if (observeTokenPollFault && request.method === "POST" && upstreamUrl.pathname === "/api/auth/device/code") tokenPollFault.authorizations++;
    if (tokenPoll && throttleNextTokenPoll) {
      throttleNextTokenPoll = false;
      tokenPollFault.injected++;
      tokenPollFault.http429s++;
      request.resume();
      response.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      response.end(JSON.stringify({ error: "rate_limited" }));
      return;
    }
    const upstream = (upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest)(upstreamUrl, {
      method: request.method, headers: { ...request.headers, host: upstreamUrl.host },
    }, result => {
      if (runnerRequest) runnerRequests.push({ method: request.method ?? "GET", path: upstreamUrl.pathname, status: result.statusCode ?? 502 });
      if (disconnectAfterCompletion && request.method === "POST" && /^\/v1\/remote-session-commands\/[^/]+\/complete$/.test(upstreamUrl.pathname) && result.statusCode === 200) {
        // Forward FIRST: Den committed the real receipt. Only its acknowledgement
        // is hidden. Refusing the request before upstream would be false proof.
        disconnectAfterCompletion = false;
        runnerOffline = true;
        runnerFault.lostCompletionResponses++;
        result.resume();
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "synthetic_lost_completion_acknowledgement" }));
        return;
      }
      if (tokenPoll && observeTokenPollFault) {
        if (result.statusCode === 429) tokenPollFault.http429s++;
        if (tokenPollFault.injected === 1) tokenPollFault.retriedPolls++;
      }
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end("Fixture forwarding failed");
    });
    if (tokenPoll) upstream.setTimeout(30_000, () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
}
async function initialize() {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const bundleText = readFileSync(join(root, "plugin-artifact.json"), "utf8");
  const artifactSha = createHash("sha256").update(bundleText).digest("hex");
  if (artifactSha !== process.env.NATIVE_FIXTURE_ARTIFACT_SHA) throw new Error("Uploaded plugin artifact receipt mismatch");
  const bundle = object(JSON.parse(bundleText));
  if (!Array.isArray(bundle.files) || bundle.files.length === 0) throw new Error("Plugin artifact is empty");
  const plugin = join(root, "plugin");
  mkdirSync(join(plugin, "dist"), { recursive: true });
  const seen = new Set();
  for (const value of bundle.files) {
    const file = object(value);
    const name = string(file.name);
    if (!/^[A-Za-z0-9_.-]+\.js$/.test(name) || seen.has(name)) throw new Error("Invalid plugin artifact filename");
    seen.add(name);
    const bytes = Buffer.from(string(file.base64), "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== string(file.sha256)) throw new Error(`Plugin artifact hash mismatch: ${name}`);
    writeFileSync(join(plugin, "dist", name), bytes);
  }
  if (!seen.has("server.js")) throw new Error("Plugin artifact has no compiled server entrypoint");
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "opencode-openwork", version: "0.1.0", type: "module", exports: { ".": "./dist/server.js", "./server": "./dist/server.js" } }));
  // Native folder plugins resolve root server.* / index.*, not package exports.
  writeFileSync(join(plugin, "server.js"), 'export { default } from "./dist/server.js"\n');
  const binaryIntegrity = await install();
  proxy = startProxy();
  const apiPort = await listen(proxy);
  const config = join(home, ".config", "opencode");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [{ package: pathToFileURL(plugin).href, options: {
      apiBaseUrl: `http://127.0.0.1:${apiPort}`,
      ...(process.env.NATIVE_FIXTURE_REMOTE_SESSIONS === "1" ? { remoteSessions: true, label: "OpenCode proof computer" } : {}),
    } }],
  }, null, 2));
  const reservation = createServer();
  const servicePort = await listen(reservation);
  await close(reservation);
  const configured = await run(["service", "set", "port", String(servicePort)]);
  if (configured.status !== 0) throw new Error(`Configuring the native service failed: ${configured.stdout}${configured.stderr}`);
  serviceConfigured = true;
  // plugin.list starts Location activation but only reads its current inventory.
  // In native 2.0.26 integration.list waits for Plugin.awaitActivation, without
  // creating a session or admitting a prompt.
  const activation = await run(["api", "get", `/api/integration?location%5Bdirectory%5D=${encodeURIComponent(home)}`]);
  if (activation.status !== 0) throw new Error(`Native plugin activation barrier failed: ${activation.stdout}${activation.stderr}`);
  return {
    home, directory: realpathSync(home), platform, binaryIntegrity, artifactSha, servicePort,
    helperPid: process.pid,
    sourceFingerprint: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
    sourceSha: string(bundle.sourceSha),
  };
}
function startLogin(body) {
  if (!["browser", "code"].includes(body.method)) throw new Error("Unknown login method");
  if (body.throttleTokenPoll === true) {
    if (body.method !== "browser" || observeTokenPollFault) throw new Error("Token fault can only be armed once for browser sign-in");
    observeTokenPollFault = true;
    throttleNextTokenPoll = true;
  }
  const id = String(logins.size + 1);
  const child = spawn(binary, ["auth", "login", "openwork", "--method", body.method], { env, cwd: home });
  children.add(child);
  const login = { child, output: "", verificationUrl: null, userCode: null, result: null, error: null };
  logins.set(id, login);
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const onData = chunk => {
    login.output += String(chunk);
    const text = plain(login.output);
    login.verificationUrl ??= /(https?:\/\/\S+\/device\?\S+)/.exec(text)?.[1] ?? null;
    login.userCode ??= /code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text)?.[1] ?? null;
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.once("error", error => { login.error = error.message; });
  child.once("close", status => {
    clearTimeout(timer);
    children.delete(child);
    login.result = { status, stdout: plain(login.output), stderr: "" };
  });
  return { id };
}
async function shutdown() {
  if (stopping) return stopping;
  stopping = (async () => {
    for (const child of children) child.kill("SIGKILL");
    if (binary && serviceConfigured && existsSync(home)) {
      const stopped = await run(["service", "stop"], 30_000);
      if (stopped.status !== 0) throw new Error(`Private native service cleanup failed: ${stopped.stdout}${stopped.stderr}`);
    }
    await close(proxy);
  })();
  return stopping;
}
async function dispatch(body) {
  const command = string(body.command);
  if (command === "initialize") return initialized ??= initialize();
  if (command === "shutdown") { await shutdown(); return { stopped: true }; }
  if (!initialized) throw new Error("Native fixture is not initialized");
  await initialized;
  if (command === "run") return run(body.args, body.timeoutMs ?? 120_000);
  if (command === "login-start") return startLogin(body);
  if (command === "login-status" || command === "login-stop") {
    const login = logins.get(string(body.id));
    if (!login) throw new Error("Unknown fixture login");
    if (command === "login-stop") login.child.kill("SIGTERM");
    return { verificationUrl: login.verificationUrl, userCode: login.userCode, result: login.result, error: login.error };
  }
  if (command === "runner-witness") return { ...runnerFault, requests: [...runnerRequests] };
  if (command === "token-witness") return { ...tokenPollFault };
  if (command === "disconnect-next-completion") { disconnectAfterCompletion = true; return {}; }
  if (command === "runner-connection") {
    if (typeof body.online !== "boolean") throw new Error("Expected a runner link boolean");
    runnerOffline = !body.online;
    return {};
  }
  if (command === "restart") {
    const before = await nativeInfo();
    const stopped = await run(["service", "stop"], 30_000);
    if (stopped.status !== 0) throw new Error(`Stopping the native service failed: ${stopped.stdout}${stopped.stderr}`);
    runnerOffline = false;
    const started = await run(["service", "start"], 60_000);
    if (started.status !== 0) throw new Error(`Starting the native service failed: ${started.stdout}${started.stderr}`);
    const activation = await run(["api", "get", `/api/integration?location%5Bdirectory%5D=${encodeURIComponent(home)}`]);
    if (activation.status !== 0) throw new Error(`Native plugin activation failed: ${activation.stdout}${activation.stderr}`);
    const after = await nativeInfo();
    if (before.pid === after.pid) throw new Error("Native restart did not change the actual service PID");
    return { stopped: stopped.status, started: started.status, beforePid: before.pid, afterPid: after.pid };
  }
  throw new Error("Unknown native fixture command");
}
const control = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/control" || request.headers.authorization !== `Bearer ${token}`) {
    request.resume();
    response.writeHead(403);
    response.end();
    return;
  }
  try {
    let text = "";
    for await (const chunk of request) {
      text += String(chunk);
      if (text.length > 128_000) throw new Error("Fixture control request too large");
    }
    const data = await dispatch(object(JSON.parse(text)));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, data }));
  } catch (error) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
});
await listen(control, integer(Number(process.env.PORT), 1024, 65535));
console.log("Native fixture control is ready on loopback");
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  shutdown().catch(error => console.error(error)).finally(async () => {
    await close(control);
    process.exit(0);
  });
});
