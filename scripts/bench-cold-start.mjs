#!/usr/bin/env node
/**
 * Cold-start benchmark harness for Electron OpenWork.
 * Use --home shared for a relaunch-style reused HOME/XDG profile, or
 * --home fresh for first-launch-ever isolated HOME/XDG directories per run.
 *
 * Workspace profile creates an isolated userData + server config + local
 * workspace per run, loads the built renderer via file://, waits until startup
 * tracing records server.listening, server.opencodeListening, and mcp.syncAll,
 * then reports metrics from trace.ndjson.
 *
 * Firstrun profile intentionally creates no workspace. It only measures the
 * window path; server, opencode, and MCP metrics are N/A by construction.
 *
 * Seeded profile first launches once against a seed userData, waits for
 * runtime.serverReady, reads openwork-server-tokens.json, registers N local
 * streamable-HTTP MCP servers through POST /workspace/:id/mcp, then copies that
 * seed userData into each measured run. The mock MCP servers are plain node:http
 * servers that answer initialize, notifications/initialized, and tools/list
 * after --mcp-latency ms per response.
 */
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const rendererIndexPath = path.join(repoRoot, "apps", "app", "dist", "index.html");
const embeddedServerPath = path.join(repoRoot, "apps", "server", "dist", "embedded.js");
const sidecarOpencodePath = path.join(desktopRoot, "resources", "sidecars", process.platform === "win32" ? "opencode.exe" : "opencode");

function parseArgs(argv) {
  const flags = {
    runs: 5,
    warmup: 0,
    label: "baseline",
    out: "",
    profile: "workspace",
    home: "shared",
    mcp: 3,
    mcpLatency: 150,
    compare: "",
    timeoutMs: 120_000,
    keepArtifacts: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep-artifacts") {
      flags.keepArtifacts = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined) throw new Error(`Missing value for ${arg}`);
    index += 1;
    if (arg === "--runs") flags.runs = Number.parseInt(next, 10);
    else if (arg === "--warmup") flags.warmup = Number.parseInt(next, 10);
    else if (arg === "--label") flags.label = next;
    else if (arg === "--out") flags.out = next;
    else if (arg === "--profile") flags.profile = next;
    else if (arg === "--home") flags.home = next;
    else if (arg === "--mcp") flags.mcp = Number.parseInt(next, 10);
    else if (arg === "--mcp-latency") flags.mcpLatency = Number.parseInt(next, 10);
    else if (arg === "--compare") flags.compare = next;
    else if (arg === "--timeout-ms") flags.timeoutMs = Number.parseInt(next, 10);
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!Number.isInteger(flags.runs) || flags.runs <= 0) throw new Error("--runs must be a positive integer");
  if (!Number.isInteger(flags.warmup) || flags.warmup < 0) throw new Error("--warmup must be zero or greater");
  if (!Number.isInteger(flags.mcp) || flags.mcp < 0) throw new Error("--mcp must be zero or greater");
  if (!Number.isFinite(flags.mcpLatency) || flags.mcpLatency < 0) throw new Error("--mcp-latency must be zero or greater");
  if (!Number.isFinite(flags.timeoutMs) || flags.timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
  if (flags.profile !== "firstrun" && flags.profile !== "workspace" && flags.profile !== "seeded") {
    throw new Error("--profile must be firstrun, workspace, or seeded");
  }
  if (flags.home !== "fresh" && flags.home !== "shared") throw new Error("--home must be fresh or shared");
  if (!flags.out) flags.out = path.join(repoRoot, ".bench", `${flags.label}.json`);
  return flags;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveElectronBinary() {
  try {
    const require = createRequire(path.join(desktopRoot, "package.json"));
    const electronBinary = require("electron");
    return typeof electronBinary === "string" && electronBinary.trim() ? electronBinary : "";
  } catch {
    return "";
  }
}

async function preflight() {
  const missing = [];
  if (!(await exists(rendererIndexPath))) {
    missing.push(`Missing ${path.relative(repoRoot, rendererIndexPath)}. Run: pnpm build:ui`);
  }
  if (!(await exists(embeddedServerPath))) {
    missing.push(`Missing ${path.relative(repoRoot, embeddedServerPath)}. Run: pnpm --filter openwork-server build`);
  }
  if (!(await exists(sidecarOpencodePath))) {
    missing.push(`Missing ${path.relative(repoRoot, sidecarOpencodePath)}. Run: pnpm --filter @openwork/desktop prepare:sidecar`);
  }
  const electronBinary = resolveElectronBinary();
  if (!electronBinary || !(await exists(electronBinary))) {
    missing.push("Missing resolvable electron binary from node_modules. Run: pnpm install");
  }
  if (missing.length > 0) {
    for (const line of missing) console.error(line);
    process.exit(1);
  }
  return electronBinary;
}

function safeLabel(label) {
  return label.replace(/[^a-zA-Z0-9._-]+/g, "_") || "baseline";
}

function workspaceState(workspaceDir) {
  const workspaceId = "bench-workspace";
  return {
    selectedId: workspaceId,
    selectedWorkspaceId: workspaceId,
    watchedId: workspaceId,
    watchedWorkspaceId: workspaceId,
    activeId: workspaceId,
    workspaces: [
      {
        id: workspaceId,
        name: "Bench Workspace",
        displayName: "Bench Workspace",
        path: workspaceDir,
        preset: "starter",
        workspaceType: "local",
        remoteType: null,
        baseUrl: null,
        directory: null,
        openworkHostUrl: null,
        openworkToken: null,
        openworkClientToken: null,
        openworkHostToken: null,
        openworkWorkspaceId: null,
        openworkWorkspaceName: null,
        sandboxBackend: null,
        sandboxRunId: null,
        sandboxContainerName: null,
      },
    ],
  };
}

function serverConfig(workspaceDir) {
  return { workspaces: workspaceState(workspaceDir).workspaces };
}

async function prepareFirstrunUserData(runDir) {
  const userDataDir = path.join(runDir, "userdata");
  await prepareProfileDirs(runDir);
  await mkdir(userDataDir, { recursive: true });
  return { userDataDir, workspaceDir: null, serverConfigPath: path.join(runDir, "server.json") };
}

async function prepareWorkspaceUserData(runDir, options = {}) {
  const userDataDir = path.join(runDir, "userdata");
  const workspaceDir = path.join(runDir, "workspace");
  const serverConfigPath = options.serverConfigInUserData
    ? path.join(userDataDir, "server.json")
    : path.join(runDir, "server.json");
  await prepareProfileDirs(runDir);
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const state = workspaceState(workspaceDir);
  await writeFile(
    path.join(userDataDir, "openwork-workspaces.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  await writeFile(serverConfigPath, `${JSON.stringify(serverConfig(workspaceDir), null, 2)}\n`, "utf8");
  return { userDataDir, workspaceDir, serverConfigPath };
}

async function prepareProfileDirs(runDir) {
  await Promise.all([
    mkdir(path.join(runDir, "home"), { recursive: true }),
    mkdir(path.join(runDir, "xdg", "config"), { recursive: true }),
    mkdir(path.join(runDir, "xdg", "data"), { recursive: true }),
    mkdir(path.join(runDir, "xdg", "cache"), { recursive: true }),
    mkdir(path.join(runDir, "xdg", "state"), { recursive: true }),
    mkdir(path.join(runDir, "openwork-data"), { recursive: true }),
  ]);
}

function normalizeWorkspaceKey(value) {
  const workspacePath = String(value ?? "").trim();
  if (!workspacePath) return "";
  return path.resolve(workspacePath).replace(/\\/g, "/").toLowerCase();
}

function linuxChromiumArgs() {
  return ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"];
}

function mergeLaunchArgs(existing, extras) {
  const args = String(existing ?? "").trim().split(/\s+/).filter(Boolean);
  for (const extra of extras) {
    if (!args.includes(extra)) args.push(extra);
  }
  return args.join(" ");
}

async function prepareSeededUserData(runDir, seedUserDataDir) {
  const userDataDir = path.join(runDir, "userdata");
  const workspaceDir = path.join(runDir, "workspace");
  await prepareProfileDirs(runDir);
  await cp(seedUserDataDir, userDataDir, { recursive: true, force: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(userDataDir, "openwork-workspaces.json"),
    `${JSON.stringify(workspaceState(workspaceDir), null, 2)}\n`,
    "utf8",
  );
  const serverConfigPath = path.join(userDataDir, "server.json");
  await rewriteServerConfigWorkspace(serverConfigPath, workspaceDir);
  await rewriteTokenStoreWorkspace(path.join(userDataDir, "openwork-server-tokens.json"), workspaceDir);
  return { userDataDir, workspaceDir, serverConfigPath };
}

async function rewriteServerConfigWorkspace(serverConfigPath, workspaceDir) {
  try {
    const config = JSON.parse(await readFile(serverConfigPath, "utf8"));
    if (Array.isArray(config.workspaces)) {
      config.workspaces = config.workspaces.map((workspace) => {
        if (!workspace || typeof workspace !== "object") return workspace;
        return {
          ...workspace,
          path: workspaceDir,
          directory: workspaceDir,
        };
      });
      await writeFile(serverConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    }
  } catch {
    // Seeded profile setup will fail later if this cannot be rewritten.
  }
}

async function rewriteTokenStoreWorkspace(tokenPath, workspaceDir) {
  try {
    const store = JSON.parse(await readFile(tokenPath, "utf8"));
    if (!store || typeof store !== "object" || !store.workspaces || typeof store.workspaces !== "object") return;
    const entries = Object.entries(store.workspaces);
    if (entries.length === 0) return;
    const nextWorkspaces = {};
    const first = entries[0];
    nextWorkspaces[normalizeWorkspaceKey(workspaceDir)] = first[1];
    store.workspaces = nextWorkspaces;
    await writeFile(tokenPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  } catch {
    // Seeded profile can regenerate tokens if the copied store cannot be reused.
  }
}

function launchElectron({ electronBinary, tracePath, userDataDir, serverConfigPath, runDir, homeRootDir }) {
  const linuxArgs = process.platform === "linux" ? linuxChromiumArgs() : [];
  const profileRoot = homeRootDir ?? runDir;
  const env = {
    ...process.env,
    OPENWORK_STARTUP_TRACE: tracePath,
    OPENWORK_ELECTRON_USERDATA: userDataDir,
    OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN: "1",
    OPENWORK_ELECTRON_START_URL: pathToFileURL(rendererIndexPath).href,
    OPENWORK_ELECTRON_APP_IDENTIFIER: `com.differentai.openwork.bench.${process.pid}.${path.basename(runDir).replace(/[^a-zA-Z0-9.-]+/g, "-")}`,
    OPENWORK_ELECTRON_APP_NAME: `OpenWork Bench ${path.basename(runDir)}`,
    OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION: "1",
    OPENWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY: "1",
    OPENWORK_SERVER_CONFIG: serverConfigPath,
    OPENWORK_RUNTIME_DB: path.join(path.dirname(serverConfigPath), "runtime.sqlite"),
    OPENWORK_DATA_DIR: path.join(runDir, "openwork-data"),
    HOME: path.join(profileRoot, "home"),
    USERPROFILE: path.join(profileRoot, "home"),
    XDG_CONFIG_HOME: path.join(profileRoot, "xdg", "config"),
    XDG_DATA_HOME: path.join(profileRoot, "xdg", "data"),
    XDG_CACHE_HOME: path.join(profileRoot, "xdg", "cache"),
    XDG_STATE_HOME: path.join(profileRoot, "xdg", "state"),
  };
  delete env.OPENWORK_DEV_MODE;
  delete env.OPENCODE_MODELS_URL;
  delete env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT;
  if (process.platform === "linux") {
    if (!String(env.DISPLAY ?? "").trim()) env.DISPLAY = ":99";
    env.ELECTRON_DISABLE_SANDBOX = "1";
    env.ELECTRON_EXTRA_LAUNCH_ARGS = mergeLaunchArgs(env.ELECTRON_EXTRA_LAUNCH_ARGS, linuxArgs);
  }

  const child = spawn(electronBinary, [...linuxArgs, desktopRoot], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const logs = [];
  const collect = (source, chunk) => {
    logs.push(...String(chunk).split(/\r?\n/).filter(Boolean).map((line) => `[${source}] ${line}`));
    if (logs.length > 400) logs.splice(0, logs.length - 400);
  };
  child.stdout?.on("data", (chunk) => collect("stdout", chunk));
  child.stderr?.on("data", (chunk) => collect("stderr", chunk));
  void writeFile(path.join(runDir, "electron.pid"), `${child.pid ?? ""}\n`, "utf8").catch(() => undefined);
  return { child, logs };
}

function signalTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // ignore
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function terminate(child) {
  signalTree(child, "SIGTERM");
  const stopped = await waitForExit(child, 5000);
  if (!stopped) {
    signalTree(child, "SIGKILL");
    await waitForExit(child, 2000);
  }
}

async function readTrace(tracePath) {
  try {
    const raw = await readFile(tracePath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hasEvent(events, name, kind) {
  return events.some((event) => event?.name === name && (!kind || event.kind === kind));
}

function requiredEvents(profile) {
  if (profile === "firstrun") return [{ name: "window.readyToShow", kind: "mark" }];
  return [
    { name: "server.listening", kind: "mark" },
    { name: "server.opencodeListening", kind: "mark" },
    { name: "mcp.syncAll", kind: "span" },
  ];
}

function missingRequiredEvents(events, profile) {
  return requiredEvents(profile).filter((event) => !hasEvent(events, event.name, event.kind));
}

function hasRequiredEvents(events, profile) {
  return missingRequiredEvents(events, profile).length === 0;
}

function profileNotes(profile) {
  if (profile !== "firstrun") return [];
  return [
    "firstrun uses an empty userData with no selected local workspace; server, opencode, MCP sync, and cloud metrics are N/A by construction.",
  ];
}

async function waitForTrace(tracePath, timeoutMs, predicate, child) {
  const startedAt = performance.now();
  let events = [];
  while (performance.now() - startedAt < timeoutMs) {
    events = await readTrace(tracePath);
    if (predicate(events)) return { events, timedOut: false, exitedEarly: false };
    if (child && child.exitCode !== null) return { events, timedOut: false, exitedEarly: true };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  events = await readTrace(tracePath);
  return { events, timedOut: true, exitedEarly: false };
}

function eventMeta(event) {
  return event && typeof event.meta === "object" && event.meta !== null ? event.meta : {};
}

function metricFromEvent(t0, event) {
  return typeof t0 === "number" && typeof event?.ts === "number" ? event.ts - t0 : null;
}

function deriveRun(events) {
  const processStart = events.find((event) => event?.src === "main" && event.name === "process.start");
  const t0 = typeof processStart?.ts === "number" ? processStart.ts : null;
  const first = (name) => events.find((event) => event?.name === name);
  const firstConnectedPoll = events.find((event) => event?.name === "mcp.cloudPoll" && eventMeta(event).connected === true);
  const firstCloudReconcile = events.find((event) => event?.name === "mcp.cloudReconcile");
  const spans = events
    .filter((event) => event?.kind === "span" && typeof event.ms === "number")
    .map((event) => ({ name: event.name, ms: event.ms, src: event.src, meta: eventMeta(event) }))
    .sort((left, right) => right.ms - left.ms);
  const cloudPollSleepMs = events
    .filter((event) => event?.name === "mcp.cloudPoll")
    .reduce((sum, event) => {
      const delay = eventMeta(event).delayMs;
      return sum + (typeof delay === "number" ? delay : 0);
    }, 0);

  return {
    t0,
    metrics: {
      window: metricFromEvent(t0, first("window.readyToShow")),
      openworkServer: metricFromEvent(t0, first("server.listening")),
      opencode: metricFromEvent(t0, first("server.opencodeListening")),
      mcpSynced: metricFromEvent(t0, first("mcp.syncAll")),
      cloudConnected: metricFromEvent(t0, firstConnectedPoll ?? firstCloudReconcile),
    },
    topSpans: spans.slice(0, 15),
    counters: {
      prepareFreshRuntimeCalls: events.filter((event) => event?.name === "boot.prepareFreshRuntime" || event?.name === "runtime.prepareFreshRuntime").length,
      enrichedPathCalls: events.filter((event) => event?.name === "runtime.enrichedPath").length,
      mcpPostCount: events.filter((event) => event?.name === "mcp.post").length,
      cloudPollCount: events.filter((event) => event?.name === "mcp.cloudPoll").length,
      cloudPollSleepMs,
    },
  };
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function aggregate(runs) {
  const metrics = ["window", "openworkServer", "opencode", "mcpSynced", "cloudConnected"];
  const result = {};
  for (const metric of metrics) {
    const values = runs
      .map((run) => run.derived.metrics[metric])
      .filter((value) => typeof value === "number" && Number.isFinite(value));
    result[metric] = values.length === 0
      ? { min: null, median: null, p95: null, max: null }
      : {
          min: Math.min(...values),
          median: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          max: Math.max(...values),
        };
  }
  return result;
}

function formatMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "—";
}

function printAggregateTable(summary) {
  console.log(`Cold start benchmark: ${summary.flags.label} (${summary.flags.profile}, home: ${summary.flags.home})`);
  for (const note of summary.profileNotes ?? []) console.log(`Note: ${note}`);
  console.log(`Runs: ${summary.runs.length} total, ${summary.aggregateInputCount} aggregated, ${summary.excludedTimeouts} timeout excluded, ${summary.excludedFailures} failed excluded, ${summary.flags.warmup} warmup excluded`);
  console.log("metric             min      median   p95      max");
  for (const [metric, values] of Object.entries(summary.aggregate)) {
    console.log(`${metric.padEnd(18)} ${formatMs(values.min).padStart(7)}  ${formatMs(values.median).padStart(7)}  ${formatMs(values.p95).padStart(7)}  ${formatMs(values.max).padStart(7)}`);
  }
  console.log("per-run           window   server   opencode mcpSync  cloud    prep enriched mcpPost cloudPoll sleep");
  for (const run of summary.runs) {
    const metrics = run.derived.metrics;
    const counters = run.derived.counters;
    const status = run.timedOut ? "timeout" : run.failed ? "failed" : run.warmup ? "warmup" : "run";
    console.log(
      `${String(run.index).padStart(3)} ${status.padEnd(8)} ${formatMs(metrics.window).padStart(7)}  ${formatMs(metrics.openworkServer).padStart(7)}  ${formatMs(metrics.opencode).padStart(7)}  ${formatMs(metrics.mcpSynced).padStart(7)}  ${formatMs(metrics.cloudConnected).padStart(7)}  ${String(counters.prepareFreshRuntimeCalls).padStart(4)} ${String(counters.enrichedPathCalls).padStart(8)} ${String(counters.mcpPostCount).padStart(7)} ${String(counters.cloudPollCount).padStart(9)} ${String(counters.cloudPollSleepMs).padStart(5)}`,
    );
  }
}

function printCompare(current, baseline) {
  const baselineHome = baseline.flags?.home ?? "fresh";
  if (baseline.flags?.profile !== current.flags.profile) {
    throw new Error(`Refusing to compare different profiles: baseline=${baseline.flags?.profile ?? "unknown"}, current=${current.flags.profile}`);
  }
  if (baselineHome !== current.flags.home) {
    throw new Error(`Refusing to compare different home modes: baseline=${baselineHome}, current=${current.flags.home}`);
  }
  console.log(`Compare median: ${baseline.flags?.label ?? "baseline"} -> ${current.flags.label} (${current.flags.profile}, home: ${current.flags.home})`);
  console.log("metric             before   after    delta    delta%");
  for (const metric of Object.keys(current.aggregate)) {
    const before = baseline.aggregate?.[metric]?.median;
    const after = current.aggregate?.[metric]?.median;
    const delta = typeof before === "number" && typeof after === "number" ? after - before : null;
    const pct = typeof before === "number" && before !== 0 && typeof delta === "number" ? (delta / before) * 100 : null;
    console.log(`${metric.padEnd(18)} ${formatMs(before).padStart(7)}  ${formatMs(after).padStart(7)}  ${formatMs(delta).padStart(7)}  ${(typeof pct === "number" ? `${pct.toFixed(1)}%` : "—").padStart(7)}`);
  }
}

async function gitSha() {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function jsonRpcResponse(body, serverIndex) {
  if (!body || typeof body !== "object") return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
  if (body.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: `bench-mcp-${serverIndex}`, version: "0.0.0" },
      },
    };
  }
  if (body.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: {
        tools: [
          { name: `bench_${serverIndex}_alpha`, description: "Synthetic benchmark tool", inputSchema: { type: "object", properties: {} } },
          { name: `bench_${serverIndex}_beta`, description: "Synthetic benchmark tool", inputSchema: { type: "object", properties: {} } },
        ],
      },
    };
  }
  if (body.method === "notifications/initialized") return null;
  return { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "Method not found" } };
}

async function startMockMcpServers(count, latencyMs) {
  const servers = [];
  for (let index = 0; index < count; index += 1) {
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        setTimeout(() => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8") || "{}";
            const body = JSON.parse(raw);
            const result = Array.isArray(body)
              ? body.map((item) => jsonRpcResponse(item, index)).filter(Boolean)
              : jsonRpcResponse(body, index);
            if (result === null) {
              response.writeHead(202);
              response.end();
              return;
            }
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(result));
          } catch {
            response.writeHead(400, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: "invalid_json" }));
          }
        }, latencyMs);
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind mock MCP server");
    servers.push({ server, url: `http://127.0.0.1:${address.port}/mcp` });
  }
  return servers;
}

async function closeMockMcpServers(servers) {
  await Promise.all(servers.map(({ server }) => new Promise((resolve) => server.close(() => resolve()))));
}

async function readOwnerToken(userDataDir) {
  const store = JSON.parse(await readFile(path.join(userDataDir, "openwork-server-tokens.json"), "utf8"));
  const workspaces = store?.workspaces && typeof store.workspaces === "object" ? Object.values(store.workspaces) : [];
  for (const workspace of workspaces) {
    if (workspace && typeof workspace === "object" && typeof workspace.ownerToken === "string" && workspace.ownerToken.trim()) {
      return workspace.ownerToken.trim();
    }
  }
  throw new Error("Seed setup could not find ownerToken in openwork-server-tokens.json");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.text();
  if (!response.ok) throw new Error(`${url} failed: ${response.status} ${body}`);
  return body ? JSON.parse(body) : null;
}

async function prepareSeedTemplate({ flags, electronBinary, rootDir }) {
  const seedRunDir = path.join(rootDir, "seed-setup");
  await rm(seedRunDir, { recursive: true, force: true });
  await mkdir(seedRunDir, { recursive: true });
  const seed = await prepareWorkspaceUserData(seedRunDir, { serverConfigInUserData: true });
  const tracePath = path.join(seedRunDir, "trace.ndjson");
  const launched = launchElectron({
    electronBinary,
    tracePath,
    userDataDir: seed.userDataDir,
    serverConfigPath: seed.serverConfigPath,
    runDir: seedRunDir,
  });
  try {
    const ready = await waitForTrace(
      tracePath,
      flags.timeoutMs,
      (events) => hasEvent(events, "runtime.serverReady", "mark") && hasRequiredEvents(events, "workspace"),
      launched.child,
    );
    if (ready.timedOut || ready.exitedEarly) {
      const missing = missingRequiredEvents(ready.events, "workspace").map((event) => event.name).join(", ");
      throw new Error(`Seed setup did not reach runtime.serverReady with required workspace events${missing ? ` (${missing})` : ""}. Last logs:\n${launched.logs.join("\n")}`);
    }
    const readyEvent = ready.events.find((event) => event?.name === "runtime.serverReady");
    const baseUrl = eventMeta(readyEvent).baseUrl;
    if (typeof baseUrl !== "string" || !baseUrl) throw new Error("Seed setup trace did not include runtime.serverReady baseUrl");
    const ownerToken = await readOwnerToken(seed.userDataDir);
    const workspaces = await fetchJson(`${baseUrl.replace(/\/+$/, "")}/workspaces`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const workspace = Array.isArray(workspaces?.items) ? workspaces.items[0] : null;
    const workspaceId = workspace?.id;
    if (typeof workspaceId !== "string" || !workspaceId) throw new Error("Seed setup could not resolve workspace id");
    const mockServers = await startMockMcpServers(flags.mcp, flags.mcpLatency);
    for (let index = 0; index < mockServers.length; index += 1) {
      await fetchJson(`${baseUrl.replace(/\/+$/, "")}/workspace/${encodeURIComponent(workspaceId)}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `bench-mcp-${index + 1}`,
          config: { type: "remote", url: mockServers[index].url, enabled: true },
        }),
      });
    }
    await terminate(launched.child);
    return { userDataDir: seed.userDataDir, mockServers };
  } catch (error) {
    await terminate(launched.child);
    throw error;
  }
}

async function runOne({ index, flags, electronBinary, rootDir, seedUserDataDir, homeRootDir }) {
  const runDir = path.join(rootDir, String(index));
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });
  let prepared;
  if (flags.profile === "seeded" && seedUserDataDir) {
    prepared = await prepareSeededUserData(runDir, seedUserDataDir);
  } else if (flags.profile === "firstrun") {
    prepared = await prepareFirstrunUserData(runDir);
  } else {
    prepared = await prepareWorkspaceUserData(runDir);
  }
  const tracePath = path.join(runDir, "trace.ndjson");
  const launched = launchElectron({
    electronBinary,
    tracePath,
    userDataDir: prepared.userDataDir,
    serverConfigPath: prepared.serverConfigPath,
    runDir,
    homeRootDir,
  });
  const waited = await waitForTrace(
    tracePath,
    flags.timeoutMs,
    (events) => hasRequiredEvents(events, flags.profile),
    launched.child,
  );
  await terminate(launched.child);
  const events = waited.events.length > 0 ? waited.events : await readTrace(tracePath);
  const derived = deriveRun(events);
  const missingRequired = missingRequiredEvents(events, flags.profile).map((event) => event.name);
  const failed = waited.exitedEarly || (!waited.timedOut && missingRequired.length > 0);
  const result = {
    index,
    warmup: index <= flags.warmup,
    runDir,
    tracePath,
    timedOut: waited.timedOut,
    failed,
    eventCount: events.length,
    exitCode: launched.child.exitCode,
    signalCode: launched.child.signalCode,
    missingRequired,
    logs: launched.logs,
    derived,
  };
  if (!flags.keepArtifacts) {
    result.logs = launched.logs.slice(-80);
  }
  return result;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const electronBinary = await preflight();
  const rootDir = path.join(repoRoot, ".bench", safeLabel(flags.label));
  await mkdir(rootDir, { recursive: true });
  const sharedHomeDir = flags.home === "shared" ? path.join(rootDir, "shared-home") : null;
  if (sharedHomeDir) await prepareProfileDirs(sharedHomeDir);

  let seed = null;
  if (flags.profile === "seeded") {
    try {
      seed = await prepareSeedTemplate({ flags, electronBinary, rootDir });
    } catch (error) {
      console.error("Seeded profile failed during deterministic MCP seed setup; no benchmark numbers were produced.");
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    }
  }

  const runs = [];
  try {
    for (let index = 1; index <= flags.runs; index += 1) {
      console.log(`Starting run ${index}/${flags.runs}...`);
      runs.push(await runOne({
        index,
        flags,
        electronBinary,
        rootDir,
        seedUserDataDir: seed?.userDataDir ?? null,
        homeRootDir: sharedHomeDir,
      }));
    }
  } finally {
    if (seed?.mockServers) await closeMockMcpServers(seed.mockServers);
  }

  const aggregateRuns = runs.filter((run) => !run.warmup && !run.timedOut && !run.failed);
  const summary = {
    timestamp: new Date().toISOString(),
    gitSha: await gitSha(),
    flags,
    profileNotes: profileNotes(flags.profile),
    runs,
    aggregateInputCount: aggregateRuns.length,
    excludedTimeouts: runs.filter((run) => !run.warmup && run.timedOut).length,
    excludedFailures: runs.filter((run) => !run.warmup && run.failed).length,
    aggregate: aggregate(aggregateRuns),
  };

  printAggregateTable(summary);
  if (flags.compare) {
    const baseline = JSON.parse(await readFile(path.resolve(flags.compare), "utf8"));
    printCompare(summary, baseline);
  }

  await mkdir(path.dirname(path.resolve(flags.out)), { recursive: true });
  await writeFile(path.resolve(flags.out), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  if (!flags.keepArtifacts) {
    for (const run of runs) await rm(run.runDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
