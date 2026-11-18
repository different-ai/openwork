import { randomUUID } from "node:crypto";
import { denFetch } from "@openwork/behaviors";
import { defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import type { Seed } from "@openwork/env";
import { record } from "./org-invite.ts";

// Runs on the desktop VM, not the runner. Natural trials spawn GUI and CLI in
// adjacent statements: no seed.desktop readiness, renderer probe, or flag wait.
const coordinator = String.raw`
const fs = require("node:fs"), cp = require("node:child_process"), net = require("node:net");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const discovery = p => p + "/electron-userdata/openwork-ui-control.json";
const clean = value => value.replace(/Bearer\s+\S+/gi, "Bearer <redacted>").replace(/((?:device_code|access_token|authToken)["\s:=]+)[^\s",}]+/gi, "$1<redacted>");
function signalGroup(pid, signal) { try { process.kill(-pid, signal); } catch {} }
function ownedProcessIds(state) {
  // Also catch the CLI's detached Node child if its Electron parent exited.
  // Match only this fresh profile's cwd; never read process environments.
  return fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    try { return fs.readlinkSync("/proc/" + name + "/cwd") === state.profile ? [Number(name)] : []; } catch { return []; }
  });
}
async function cleanup(state) {
  if (state.cliPid) signalGroup(state.cliPid, "SIGINT");
  for (const pid of new Set([state.guiPid, ...ownedProcessIds(state)])) signalGroup(pid, "SIGTERM");
  await sleep(300);
  for (const pid of new Set([state.guiPid, state.cliPid, ...ownedProcessIds(state)])) if (pid) signalGroup(pid, "SIGKILL");
  fs.rmSync(state.profile, { recursive: true, force: true });
}
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function launch(input) {
  const p = input.profile; fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  for (const name of ["home", "electron-userdata", "xdg/config", "xdg/data", "xdg/cache", "xdg/state", "openwork/config", "openwork/data", "opencode/config"]) fs.mkdirSync(p + "/" + name, { recursive: true });
  const bootstrap = p + "/bootstrap.json";
  fs.writeFileSync(bootstrap, JSON.stringify({ baseUrl: input.webUrl, apiBaseUrl: input.apiUrl, requireSignin: false }), { mode: 0o600 });
  const port = await freePort(), log = fs.openSync(p + "/gui.log", "w", 0o600);
  const env = { PATH: process.env.PATH, HOME: p + "/home", DISPLAY: ":99", ELECTRON_DISABLE_SANDBOX: "1", OPENWORK_DEV_MODE: "0", OPENWORK_AUTOMATION_RUNNER: "on", OPENWORK_ENGINE_V2_PREVIEW: "0", OPENWORK_REACT_DEVTOOLS: "0", OPENWORK_ELECTRON_START_URL: "", ELECTRON_START_URL: "", OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: String(port), OPENWORK_ELECTRON_USERDATA: p + "/electron-userdata", OPENWORK_DESKTOP_BOOTSTRAP_PATH: bootstrap, XDG_CONFIG_HOME: p + "/xdg/config", XDG_DATA_HOME: p + "/xdg/data", XDG_CACHE_HOME: p + "/xdg/cache", XDG_STATE_HOME: p + "/xdg/state", OPENWORK_CONFIG_DIR: p + "/openwork/config", OPENWORK_DATA_DIR: p + "/openwork/data", OPENCODE_CONFIG_DIR: p + "/opencode/config" };
  const guiSpawnAt = Date.now();
  const gui = cp.spawn(input.binary, ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"], { env, detached: true, stdio: ["ignore", log, log], cwd: p });
  const state = { profile: p, guiPid: gui.pid, guiSpawnAt, port, configuredWebUrl: input.webUrl, configuredApiUrl: input.apiUrl };
  fs.writeFileSync(p + "/state.json", JSON.stringify(state), { mode: 0o600 });
  return { state, gui };
}
async function controlRegistered(state) {
  const targets = await fetch("http://127.0.0.1:" + state.port + "/json/list", { signal: AbortSignal.timeout(500) }).then(r => r.json());
  const target = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
  if (!target) return false;
  return new Promise(resolve => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => { ws.close(); resolve(false); }, 700);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "({ registered: ['auth.device-login.status', 'auth.device-login.start'].every(id => window.__openworkControl?.listActions?.().some(action => action.id === id)), bootstrapWebUrl: window.__OPENWORK_ELECTRON__?.meta?.desktopBootstrap?.baseUrl ?? null, bootstrapApiUrl: window.__OPENWORK_ELECTRON__?.meta?.desktopBootstrap?.apiBaseUrl ?? null, storedWebUrl: localStorage.getItem('openwork.den.baseUrl') })", returnByValue: true } }));
    ws.onmessage = event => { const value = JSON.parse(String(event.data)); if (value.id !== 1) return; clearTimeout(timer); ws.close(); const snapshot = value.result?.result?.value; resolve(snapshot?.registered ? snapshot : false); };
    ws.onerror = () => { clearTimeout(timer); ws.close(); resolve(false); };
  });
}
async function command(input, state) {
  let controlReadyAt = null, publicConfigurationObserved = null;
  if (input.waitForControl) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const snapshot = await controlRegistered(state).catch(() => false);
      if (snapshot) { controlReadyAt = Date.now(); publicConfigurationObserved = snapshot; break; }
      await sleep(100);
    }
    if (!controlReadyAt) return { ...state, setupFailure: "renderer control registration not observed", cliExitCode: null };
  }
  const args = ["login", ...(input.mode === "same-url" ? ["--base-url", input.webUrl] : [])];
  const env = { PATH: process.env.PATH, HOME: state.profile + "/home", OPENWORK_DEV_MODE: "0", ELECTRON_DISABLE_SANDBOX: "1", OPENWORK_UI_CONTROL_DISCOVERY: discovery(state.profile) };
  const cliSpawnAt = Date.now();
  const cli = cp.spawn(input.binary, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"], cwd: state.profile });
  state.cliPid = cli.pid; fs.writeFileSync(state.profile + "/state.json", JSON.stringify(state), { mode: 0o600 });
  let stdout = "", stderr = "", firstStdoutAt = null, firstOutputAt = null, firstInstructionsAt = null, exitAt = null, closedAt = null, cliExitCode = null, cliSignal = null, launchError = null, cancelledAt = null;
  const chunks = [];
  const accept = (channel, bytes) => {
    const at = Date.now(), text = String(bytes); if (!firstOutputAt) firstOutputAt = at;
    if (channel === "stdout") { if (!firstStdoutAt) firstStdoutAt = at; stdout += text; } else stderr += text;
    chunks.push({ at, channel, text: clean(text) });
    if (!firstInstructionsAt && /Then check the code [A-Z0-9]{4}-[A-Z0-9]{4} and choose the organization\./.test(stdout) && /^https?:\/\/\S+$/m.test(stdout)) firstInstructionsAt = at;
  };
  cli.stdout.on("data", bytes => accept("stdout", bytes)); cli.stderr.on("data", bytes => accept("stderr", bytes));
  cli.once("error", error => { launchError = error.code ?? "spawn failed"; exitAt = Date.now(); });
  cli.once("exit", (code, signal) => { cliExitCode = code; cliSignal = signal; exitAt = Date.now(); });
  cli.once("close", () => { closedAt = Date.now(); });
  // The real CLI owns a 20s readiness budget plus its live deployment request.
  // This test observes that behavior; it does not wait before natural spawns.
  const deadline = Date.now() + 35000;
  while (!closedAt && Date.now() < deadline) {
    if (firstInstructionsAt && !cancelledAt && Date.now() - firstInstructionsAt >= 500) { cancelledAt = Date.now(); cli.kill("SIGINT"); }
    await sleep(25);
  }
  if (!closedAt) { if (!cancelledAt) { cancelledAt = Date.now(); cli.kill("SIGINT"); } const until = Date.now() + 5000; while (!closedAt && Date.now() < until) await sleep(25); }
  const info = fs.existsSync(discovery(state.profile)) ? fs.statSync(discovery(state.profile)) : null;
  return { ...state, args, controlReadyAt, publicConfigurationObserved, cliSpawnAt, firstStdoutAt, firstOutputAt, firstInstructionsAt, cancelledAt, exitAt, closedAt, cliExitCode, cliSignal, launchError, stdout: clean(stdout), stderr: clean(stderr), chunks, timedOut: !closedAt, discovery: info ? { createdAt: info.birthtimeMs, mode: info.mode & 0o777, ownedByCurrentUser: info.uid === process.getuid() } : null, cliHasDisplay: "DISPLAY" in env, cliHasNodeMode: "ELECTRON_RUN_AS_NODE" in env, publicInstructionsSeen: firstInstructionsAt !== null };
}
async function run(input) {
  if (input.operation === "cleanup") { if (fs.existsSync(input.profile + "/state.json")) await cleanup(JSON.parse(fs.readFileSync(input.profile + "/state.json", "utf8"))); return { cleaned: true }; }
  if (input.operation === "command") {
    const state = JSON.parse(fs.readFileSync(input.profile + "/state.json", "utf8"));
    try { return await command(input, state); } finally { await cleanup(state); }
  }
  const { state, gui } = await launch(input);
  if (input.operation === "launch") { gui.unref(); return state; }
  // The first GUI spawn has just returned; command() has no readiness wait in
  // natural mode. Both spawn timestamps and all output timestamps use this VM.
  try { return await command(input, state); } finally { await cleanup(state); }
}
`;

export async function deviceLoginStartupCache(seed: Seed) {
  const binary = process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim();
  const sandbox = process.env.OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX?.trim();
  if (!binary?.startsWith("/") || !binary.endsWith("/openwork") || !sandbox) throw new Error("Startup reproduction needs an owned prepared Daytona VM and a packaged Linux openwork executable.");
  const desktopSandbox = sandbox;
  const den = await seed.den({ org: { name: "Startup cache diagnostic", admin: { name: "Startup Approver" }, members: {} } });
  async function setEnabled(enabled: boolean) {
    const result = await denFetch(den.admin, "/v1/admin/features/remoteDesktopDeviceLogin", { method: "PUT", headers: { authorization: `Bearer ${den.admin.token}` }, body: JSON.stringify({ enabled, killed: false }), signal: AbortSignal.timeout(10_000) });
    if (!result.response.ok) throw new Error(`Set isolated deployment flag: HTTP ${result.response.status}`);
  }
  async function confirmFeatures(expectedEnabled: boolean) {
    const response = await fetch(`${den.ref.apiUrl}/v1/features`, { signal: AbortSignal.timeout(10_000) });
    const body = record(await response.json());
    if (!response.ok || record(body.features).remoteDesktopDeviceLogin !== expectedEnabled) throw new Error(`The real isolated Den must report device sign-in enabled=${expectedEnabled} before GUI launch.`);
    return { status: response.status, enabled: expectedEnabled };
  }
  await setEnabled(true);
  await confirmFeatures(true);
  async function requestMetadata() {
    return (await den.apiLog()).split("\n").flatMap(line => {
      try {
        const value = record(JSON.parse(line));
        const route = value.http_route;
        if (route !== "/v1/features" && !(typeof route === "string" && route.startsWith("/api/auth/"))) return [];
        return [{ at: value.time ?? value.timestamp ?? value.at ?? null, method: value.http_method, status: value.http_status_code, route, clock: "Den host (not compared against desktop-VM timestamps)" }];
      } catch { return []; }
    });
  }
  // Natural trials retain the deployment's exact real web/API URLs. The
  // separate bridge-ready comparison does not wait for feature-cache readiness
  // or alter discovery responses, deployment URLs, or application state.
  const profiles = new Set<string>();
  async function remote(input: Record<string, unknown>) {
    const source = `${coordinator}\nrun(${JSON.stringify(input)}).then(value => process.stdout.write(JSON.stringify(value)), error => { console.error(error.message); process.exitCode = 1; });`;
    const encoded = Buffer.from(source).toString("base64");
    const result = await execInSandbox(defaultDaytonaExec, desktopSandbox, `node -e "eval(Buffer.from(\\\"${encoded}\\\",\\\"base64\\\").toString())"`, { timeoutMs: 75_000, context: "isolated packaged startup observation" });
    return record(JSON.parse(result.stdout));
  }
  async function trial(mode: "default" | "same-url", bridgeReady = false, expectedEnabled = true) {
    const featureConfirmation = await confirmFeatures(expectedEnabled);
    const beforeRequests = await requestMetadata();
    const profile = `/tmp/openwork-startup-cache-${randomUUID()}`; profiles.add(profile);
    const base = { binary, profile, mode, webUrl: den.ref.webUrl, apiUrl: den.ref.apiUrl };
    try {
      let result: Record<string, unknown>;
      if (!bridgeReady) result = await remote({ ...base, operation: "immediate" });
      else {
        await remote({ ...base, operation: "launch" });
        result = await remote({ ...base, operation: "command", waitForControl: true });
      }
      const requests = (await requestMetadata()).slice(beforeRequests.length);
      return {
        mode, kind: !expectedEnabled ? "flag-off-action-registered" : bridgeReady ? "bridge-registered-startup-comparison" : "natural-immediate",
        featureConfirmation, result, requests,
        observedAuthPostCount: requests.filter(row => row.method === "POST" && row.route.startsWith("/api/auth/")).length,
        authRouteObservation: "Normalized auth route metadata, not request bodies. Wildcard POSTs conservatively include any device-code POST.",
      };
    } finally {
      await remote({ operation: "cleanup", profile }); profiles.delete(profile);
    }
  }
  return {
    den, trial, featureRequestMetadata: requestMetadata,
    async flagOffTrial() {
      await setEnabled(false);
      try { return await trial("default", true, false); }
      finally { await setEnabled(true); }
    },
    async [Symbol.asyncDispose]() { for (const profile of profiles) await remote({ operation: "cleanup", profile }); },
  };
}
