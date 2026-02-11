#!/usr/bin/env bun

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";

type SandboxMode = "none" | "auto" | "docker" | "container";
type ApprovalMode = "manual" | "auto";

type Entrypoint = {
  path: string;
  rw: boolean;
  label: string;
};

type Instance = {
  id: string;
  name: string;
  avatarSeed: string;
  createdAt: number;
  dir: string;
  workspaceDir: string;
  entrypoints: Entrypoint[];
  openwork: {
    host: string;
    port: number;
    url: string;
    token: string;
    hostToken: string;
    ownerToken?: string;
    approval: ApprovalMode;
  };
  openwrk?: {
    sandbox: SandboxMode;
    sandboxImage?: string;
    sandboxAllowlistPath?: string;
    stopCommand?: string;
    startedAt?: number;
  };
};

type AgentLabSchedule =
  | { kind: "interval"; seconds: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

type AgentLabAutomation = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: AgentLabSchedule;
  prompt: string;
};

type AgentLabAutomationStore = {
  schemaVersion: number;
  updatedAt: number;
  items: AgentLabAutomation[];
};

type ConnectArtifact = {
  kind: "openwork.connect.v1";
  hostUrl: string;
  workspaceId: string;
  workspaceUrl: string;
  token: string;
  tokenScope: "owner" | "collaborator" | "viewer";
  createdAt: number;
};

function usage(): string {
  return [
    "openwork-agent-lab",
    "",
    "Commands:",
    "  create   Create a new Agent Lab instance",
    "  list     List existing instances",
    "  start    Start an instance (spawns openwrk)",
    "  stop     Stop an instance (stops sandbox container)",
    "  status   Show instance status (health + workspace id)",
    "  open     Print Toy UI URL for an instance",
    "  scheduler Manage scheduled automations (launchd)",
    "  delete   Delete an instance directory (danger)",
    "",
    "Options:",
    "  --dir <path>         Base directory (default: ~/.openwork/agent-lab)",
    "  --name <name>        Agent name (create)",
    "  --id <id>            Instance id (create)",
    "  --port <port>        OpenWork server port (create/start)",
    "  --approval <mode>    manual|auto (default: manual)",
    "  --sandbox <mode>     none|auto|docker|container (default: auto)",
    "  --sandbox-image <id> Sandbox image (default: openwrk default)",
    "  --entrypoint <spec>  Extra mount: /path[:label][:ro|rw] (repeatable)",
    "  --scope <scope>      owner|collaborator (open)",
    "  --start              Start immediately after create",
    "  --help               Show help",
  ].join("\n");
}

function readFlag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const next = argv[idx + 1];
  if (!next || next.startsWith("--")) return undefined;
  return next;
}

function readFlags(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== name) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) continue;
    out.push(next);
  }
  return out;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function readNumberFlag(argv: string[], name: string): number | undefined {
  const raw = readFlag(argv, name);
  if (!raw) return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num)) return undefined;
  return Math.trunc(num);
}

function normalizeApproval(raw: string | undefined): ApprovalMode {
  if (raw === "auto") return "auto";
  return "manual";
}

function normalizeSandbox(raw: string | undefined): SandboxMode {
  if (raw === "none" || raw === "auto" || raw === "docker" || raw === "container") return raw;
  return "auto";
}

function baseDirFromArgs(argv: string[]): string {
  const override = readFlag(argv, "--dir") ?? process.env.OPENWORK_AGENT_LAB_DIR;
  return resolve(override?.trim() ? override.trim() : join(homedir(), ".openwork", "agent-lab"));
}

function expandTildePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function sanitizeMountLabel(input: string): string {
  const raw = input.trim().toLowerCase();
  let out = "";
  let dash = false;
  for (const ch of raw) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
      dash = false;
      continue;
    }
    if (ch === "_" || ch === "-") {
      out += ch;
      dash = false;
      continue;
    }
    if (!dash) {
      out += "-";
      dash = true;
    }
  }
  out = out.replace(/^-+/, "").replace(/-+$/, "");
  return out || "mount";
}

function uniqueLabel(label: string, used: Set<string>): string {
  let candidate = label;
  let i = 2;
  while (used.has(candidate)) {
    candidate = `${label}-${i}`;
    i++;
  }
  used.add(candidate);
  return candidate;
}

function parseEntrypointSpec(spec: string, usedLabels: Set<string>): Entrypoint {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error("invalid_entrypoint: empty");

  let rw = false;
  let base = trimmed;
  if (trimmed.endsWith(":ro")) {
    rw = false;
    base = trimmed.slice(0, -3);
  } else if (trimmed.endsWith(":rw")) {
    rw = true;
    base = trimmed.slice(0, -3);
  }

  const idx = base.indexOf(":");
  const rawPath = (idx > 0 ? base.slice(0, idx) : base).trim();
  const rawLabel = (idx > 0 ? base.slice(idx + 1) : "").trim();
  if (!rawPath) throw new Error(`invalid_entrypoint: ${spec}`);

  const expanded = expandTildePath(rawPath);
  const absPath = resolve(expanded);
  const derived = sanitizeMountLabel(rawLabel || basename(absPath));
  const label = uniqueLabel(derived, usedLabels);
  return { path: absPath, rw, label };
}

async function canBind(host: string, port: number): Promise<boolean> {
  return await new Promise((resolveResult) => {
    const server = createNetServer();
    server.once("error", () => {
      try { server.close(); } catch {}
      resolveResult(false);
    });
    server.listen(port, host, () => {
      server.close(() => resolveResult(true));
    });
  });
}

async function allocatePort(host: string, preferred: number | undefined, avoid: Set<number>): Promise<number> {
  if (preferred) return preferred;
  for (let port = 8787; port < 9800; port++) {
    if (avoid.has(port)) continue;
    if (await canBind(host, port)) return port;
  }
  throw new Error("no_free_port");
}

function instanceDir(baseDir: string, id: string): string {
  return join(baseDir, "instances", id);
}

function agentPath(dir: string): string {
  return join(dir, "agent.json");
}

async function loadInstance(dir: string): Promise<Instance> {
  const raw = await readFile(agentPath(dir), "utf8");
  return JSON.parse(raw) as Instance;
}

async function saveInstance(dir: string, instance: Instance): Promise<void> {
  await writeFile(agentPath(dir), JSON.stringify(instance, null, 2));
}

function randomToken(): string {
  // URL-safe enough for a toy: UUID without dashes.
  return randomUUID().replaceAll("-", "");
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  if (existsSync(path)) return;
  await ensureDir(dirname(path));
  await writeFile(path, content);
}

function defaultPersonality(name: string): string {
  return [
    "# Personality",
    "",
    `You are ${name}, a calm and serious AI co-worker.`,
    "",
    "- Tone: professional, direct, not overly friendly.",
    "- Be transparent about what you are doing.",
    "- Prefer short checkpoints over long monologues.",
    "",
    "When unsure, ask one clarifying question.",
    "",
  ].join("\n");
}

function defaultBehavior(): string {
  return [
    "# Behavior",
    "",
    "Conversation-first configuration:",
    "- The user configures you by talking to you.",
    "- After completing a task, if the user says 'turn this into a skill', create a new skill in .opencode/skills/<name>/SKILL.md.",
    "",
    "Checkpoints and progress:",
    "- Respond quickly with an acknowledgement and what you will do next.",
    "- For long tasks, do a quick preflight step first, then the heavy step.",
    "- If something will take minutes, say so before you start.",
    "",
  ].join("\n");
}

async function provisionWorkspace(
  workspaceDir: string,
  agent: { id: string; name: string; avatarSeed: string; entrypoints: Entrypoint[] },
): Promise<void> {
  await ensureDir(workspaceDir);
  await ensureDir(join(workspaceDir, ".opencode"));
  await ensureDir(join(workspaceDir, ".opencode", "agent"));
  await ensureDir(join(workspaceDir, ".opencode", "skills"));
  await ensureDir(join(workspaceDir, ".opencode", "commands"));
  await ensureDir(join(workspaceDir, ".opencode", "openwork", "inbox"));
  await ensureDir(join(workspaceDir, ".opencode", "openwork", "outbox"));

  await writeIfMissing(
    join(workspaceDir, ".opencode", "agent", "personality.md"),
    defaultPersonality(agent.name),
  );
  await writeIfMissing(join(workspaceDir, ".opencode", "agent", "behavior.md"), defaultBehavior());

  const openworkConfigPath = join(workspaceDir, ".opencode", "openwork.json");
  if (!existsSync(openworkConfigPath)) {
    const payload = {
      agentLab: {
        agent: {
          id: agent.id,
          name: agent.name,
          avatarSeed: agent.avatarSeed,
        },
        entrypoints: agent.entrypoints.map((e) => ({ path: e.path, rw: e.rw, label: e.label })),
      },
    };
    await writeFile(openworkConfigPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }

  const configPath = join(workspaceDir, "opencode.json");
  if (!existsSync(configPath)) {
    const opencodeConfig = {
      $schema: "https://opencode.ai/config.json",
      instructions: [
        ".opencode/agent/personality.md",
        ".opencode/agent/behavior.md",
      ],
      // Sandbox provides the primary filesystem safety boundary.
      permission: {
        external_directory: "deny",
      },
    };
    await writeFile(configPath, JSON.stringify(opencodeConfig, null, 2));
  }
}

async function listInstanceDirs(baseDir: string): Promise<string[]> {
  const root = join(baseDir, "instances");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

async function requestJson(
  url: string,
  options?: {
    token?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  },
): Promise<any> {
  const headers: Record<string, string> = { ...(options?.headers ?? {}) };
  if (options?.token && !headers.Authorization) headers.Authorization = `Bearer ${options.token}`;

  const method = (options?.method ?? (options?.body ? "POST" : "GET")).toUpperCase();
  let body: BodyInit | undefined;
  if (options?.body !== undefined && method !== "GET" && method !== "HEAD") {
    if (typeof options.body === "string") {
      body = options.body;
    } else {
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
  }

  const timeoutMs = options?.timeoutMs ?? 4000;
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json && json.message ? json.message : (text || res.statusText);
    throw new Error(`http_${res.status}: ${msg}`);
  }
  return json;
}

async function waitForOpenwork(url: string, timeoutMs = 12_000): Promise<void> {
  const start = Date.now();
  let last = "waiting";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
      last = `status_${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`openwork_server_unhealthy: ${last}`);
}

function openwrkBin(): string {
  const override = (process.env.OPENWORK_AGENT_LAB_OPENWRK_BIN ?? "").trim();
  if (override) return override;
  return "openwrk";
}

function sandboxAllowlistPath(instance: Instance): string {
  return join(instance.dir, "sandbox-mount-allowlist.json");
}

async function writeSandboxAllowlistFile(path: string, entrypoints: Entrypoint[]): Promise<void> {
  const payload = {
    allowedRoots: entrypoints.map((e) => ({
      path: e.path,
      allowReadWrite: e.rw,
      description: `Agent Lab entrypoint (${e.label})`,
    })),
  };
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function buildSandboxMountSpecs(entrypoints: Entrypoint[]): string[] {
  return entrypoints.map((e) => `${e.path}:${e.label}:${e.rw ? "rw" : "ro"}`);
}

function launchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

function agentLabAutomationsPath(workspaceDir: string): string {
  return join(workspaceDir, ".opencode", "openwork", "agentlab", "automations.json");
}

function agentLabLogsDir(workspaceDir: string): string {
  return join(workspaceDir, ".opencode", "openwork", "agentlab", "logs");
}

function bashQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function launchdLabel(instanceId: string, automationId: string): string {
  return `com.openwork.agentlab.${instanceId}.${automationId}`;
}

function launchdPlistPath(label: string): string {
  return join(launchAgentsDir(), `${label}.plist`);
}

function schedulerScriptPath(instance: Instance, automationId: string): string {
  return join(instance.dir, "scheduler", `${automationId}.sh`);
}

function launchdLogPath(instance: Instance, automationId: string): string {
  return join(agentLabLogsDir(instance.workspaceDir), `${automationId}.log`);
}

async function readAutomationsFromWorkspace(workspaceDir: string): Promise<AgentLabAutomationStore> {
  const path = agentLabAutomationsPath(workspaceDir);
  if (!existsSync(path)) {
    return { schemaVersion: 1, updatedAt: Date.now(), items: [] };
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentLabAutomationStore>;
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const normalized: AgentLabAutomation[] = [];
    for (const item of items) {
      const record = item as Partial<AgentLabAutomation>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const prompt = typeof record.prompt === "string" ? record.prompt : "";
      const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
      const schedule = record.schedule as AgentLabSchedule | undefined;
      if (!id || !name || !prompt || !schedule || typeof (schedule as any).kind !== "string") continue;
      normalized.push({ id, name, enabled, schedule, prompt });
    }
    return {
      schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      items: normalized,
    };
  } catch {
    return { schemaVersion: 1, updatedAt: Date.now(), items: [] };
  }
}

function buildLaunchdPlistXml(input: {
  label: string;
  scriptPath: string;
  schedule: AgentLabSchedule;
  logPath: string;
}): string {
  const header = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${input.label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/bash</string>",
    `    <string>${input.scriptPath}</string>`,
    "  </array>",
    `  <key>StandardOutPath</key><string>${input.logPath}</string>`,
    `  <key>StandardErrorPath</key><string>${input.logPath}</string>`,
  ];

  const schedule = input.schedule;
  const scheduleLines: string[] = [];
  if (schedule.kind === "interval") {
    scheduleLines.push(`  <key>StartInterval</key><integer>${schedule.seconds}</integer>`);
  } else if (schedule.kind === "daily") {
    scheduleLines.push("  <key>StartCalendarInterval</key>");
    scheduleLines.push("  <dict>");
    scheduleLines.push(`    <key>Hour</key><integer>${schedule.hour}</integer>`);
    scheduleLines.push(`    <key>Minute</key><integer>${schedule.minute}</integer>`);
    scheduleLines.push("  </dict>");
  } else if (schedule.kind === "weekly") {
    scheduleLines.push("  <key>StartCalendarInterval</key>");
    scheduleLines.push("  <dict>");
    scheduleLines.push(`    <key>Weekday</key><integer>${schedule.weekday}</integer>`);
    scheduleLines.push(`    <key>Hour</key><integer>${schedule.hour}</integer>`);
    scheduleLines.push(`    <key>Minute</key><integer>${schedule.minute}</integer>`);
    scheduleLines.push("  </dict>");
  }

  const footer = ["</dict>", "</plist>"];
  return [...header, ...scheduleLines, ...footer].join("\n") + "\n";
}

function runLaunchctl(args: string[]): void {
  spawnSync("launchctl", args, { stdio: "ignore" });
}

async function runOpenwrkStart(options: {
  workspaceDir: string;
  dataDir: string;
  sidecarDir: string;
  sandboxPersistDir: string;
  sandbox: SandboxMode;
  sandboxImage?: string;
  sandboxMounts?: string[];
  sandboxAllowlistPath?: string;
  openworkHost: string;
  openworkPort: number;
  token: string;
  hostToken: string;
  approval: ApprovalMode;
  runId: string;
}): Promise<{ stopCommand?: string }>{
  const args = [
    "start",
    "--no-tui",
    "--detach",
    "--run-id",
    options.runId,
    "--sandbox",
    options.sandbox,
    ...(options.sandbox !== "none" && options.sandboxImage ? ["--sandbox-image", options.sandboxImage] : []),
    ...(options.sandbox !== "none" && options.sandboxMounts && options.sandboxMounts.length
      ? ["--sandbox-mount", options.sandboxMounts.join(",")]
      : []),
    "--workspace",
    options.workspaceDir,
    "--data-dir",
    options.dataDir,
    "--sidecar-dir",
    options.sidecarDir,
    "--sandbox-persist-dir",
    options.sandboxPersistDir,
    "--openwork-host",
    options.openworkHost,
    "--openwork-port",
    String(options.openworkPort),
    "--openwork-token",
    options.token,
    "--openwork-host-token",
    options.hostToken,
    "--approval",
    options.approval,
    "--no-owpenbot",
  ];

  return await new Promise((resolveResult, reject) => {
    const child = spawn(openwrkBin(), args, {
      cwd: options.workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENWRK_COLOR: "0",
        ...(options.sandboxAllowlistPath
          ? { OPENWRK_SANDBOX_MOUNT_ALLOWLIST: options.sandboxAllowlistPath }
          : {}),
      },
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`openwrk_failed_${code}: ${err || out}`));
        return;
      }
      const stopLine = out
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("Stop:"));
      const stopCommand = stopLine ? stopLine.replace(/^Stop:\s*/, "").trim() : undefined;
      resolveResult({ stopCommand });
    });
  });
}

async function create(argv: string[]) {
  const baseDir = baseDirFromArgs(argv);
  const name = readFlag(argv, "--name") ?? "Scout";
  const id = (readFlag(argv, "--id") ?? "").trim() || `agent_${randomUUID().slice(0, 8)}`;
  const approval = normalizeApproval(readFlag(argv, "--approval"));
  const sandbox = normalizeSandbox(readFlag(argv, "--sandbox"));
  const sandboxImage = readFlag(argv, "--sandbox-image")?.trim() || undefined;

  const usedPorts = new Set<number>();
  const existingDirs = await listInstanceDirs(baseDir);
  for (const dir of existingDirs) {
    const path = agentPath(dir);
    if (!existsSync(path)) continue;
    try {
      const inst = await loadInstance(dir);
      const port = inst.openwork?.port;
      if (typeof port === "number" && Number.isFinite(port)) usedPorts.add(port);
    } catch {
      // ignore
    }
  }
  const port = await allocatePort("127.0.0.1", readNumberFlag(argv, "--port") ?? undefined, usedPorts);

  const usedLabels = new Set<string>();
  const entrypoints = readFlags(argv, "--entrypoint")
    .map((spec) => parseEntrypointSpec(spec, usedLabels));

  const dir = instanceDir(baseDir, id);
  const workspaceDir = join(dir, "workspace");
  await ensureDir(join(baseDir, "instances"));
  await ensureDir(dir);

  const avatarSeed = `${id}:${name}`;
  await provisionWorkspace(workspaceDir, { id, name, avatarSeed, entrypoints });

  const token = randomToken();
  const hostToken = randomToken();
  const instance: Instance = {
    id,
    name,
    avatarSeed,
    createdAt: Date.now(),
    dir,
    workspaceDir,
    entrypoints,
    openwork: {
      host: "127.0.0.1",
      port,
      url: `http://127.0.0.1:${port}`,
      token,
      hostToken,
      approval,
    },
    openwrk: {
      sandbox,
      sandboxImage,
    },
  };
  await saveInstance(dir, instance);

  console.log(JSON.stringify({ ok: true, instance }, null, 2));

  if (hasFlag(argv, "--start")) {
    await start([id, ...argv.filter((x) => x !== "--start")]);
  }
}

async function list(argv: string[]) {
  const baseDir = baseDirFromArgs(argv);
  const dirs = await listInstanceDirs(baseDir);
  const items: Instance[] = [];
  for (const dir of dirs) {
    const path = agentPath(dir);
    if (!existsSync(path)) continue;
    try {
      items.push(await loadInstance(dir));
    } catch {
      // ignore broken entries
    }
  }
  console.log(JSON.stringify({ ok: true, items }, null, 2));
}

async function start(argv: string[]) {
  const baseDir = baseDirFromArgs(argv);
  const id = argv[0];
  if (!id) throw new Error("missing_instance_id");
  const dir = instanceDir(baseDir, id);
  const instance = await loadInstance(dir);

  const port = readNumberFlag(argv, "--port") ?? instance.openwork.port;
  const approval = normalizeApproval(readFlag(argv, "--approval")) ?? instance.openwork.approval;
  const sandbox = normalizeSandbox(readFlag(argv, "--sandbox")) ?? (instance.openwrk?.sandbox ?? "auto");
  const sandboxImage = readFlag(argv, "--sandbox-image")?.trim() || instance.openwrk?.sandboxImage;

  instance.openwork.port = port;
  instance.openwork.url = `http://${instance.openwork.host}:${port}`;
  instance.openwork.approval = approval;
  if (!instance.openwrk) instance.openwrk = { sandbox };
  instance.openwrk.sandbox = sandbox;
  instance.openwrk.sandboxImage = sandboxImage;

  const dataDir = join(instance.dir, "openwrk-data");
  const sidecarDir = join(instance.dir, "sidecars");
  const sandboxPersistDir = join(instance.dir, "sandbox-persist");
  await ensureDir(dataDir);
  await ensureDir(sidecarDir);
  await ensureDir(sandboxPersistDir);

  for (const entrypoint of instance.entrypoints) {
    if (!existsSync(entrypoint.path)) {
      throw new Error(`entrypoint_missing: ${entrypoint.path}`);
    }
  }

  const sandboxMounts = sandbox !== "none" && instance.entrypoints.length
    ? buildSandboxMountSpecs(instance.entrypoints)
    : [];
  const allowlistPath = sandbox !== "none" && instance.entrypoints.length
    ? sandboxAllowlistPath(instance)
    : undefined;

  if (allowlistPath && sandboxMounts.length) {
    await writeSandboxAllowlistFile(allowlistPath, instance.entrypoints);
    instance.openwrk.sandboxAllowlistPath = allowlistPath;
  }

  const result = await runOpenwrkStart({
    workspaceDir: instance.workspaceDir,
    dataDir,
    sidecarDir,
    sandboxPersistDir,
    sandbox,
    sandboxImage,
    sandboxMounts,
    sandboxAllowlistPath: allowlistPath,
    openworkHost: instance.openwork.host,
    openworkPort: instance.openwork.port,
    token: instance.openwork.token,
    hostToken: instance.openwork.hostToken,
    approval: instance.openwork.approval,
    runId: instance.id,
  });

  instance.openwrk.stopCommand = result.stopCommand;
  instance.openwrk.startedAt = Date.now();
  await saveInstance(dir, instance);

  await waitForOpenwork(instance.openwork.url);

  const workspaces = await requestJson(`${instance.openwork.url.replace(/\/$/, "")}/workspaces`, { token: instance.openwork.token });
  const workspaceId = String(workspaces?.activeId || (workspaces?.items?.[0]?.id ?? ""));
  if (!workspaceId) throw new Error("workspace_id_missing");

  const ownerTokenExisting = (instance.openwork.ownerToken ?? "").trim();
  let ownerToken: string | undefined;
  if (ownerTokenExisting) {
    try {
      const who = await requestJson(`${instance.openwork.url.replace(/\/$/, "")}/whoami`, { token: ownerTokenExisting });
      const scope = who?.actor?.scope;
      if (scope === "owner") {
        ownerToken = ownerTokenExisting;
      }
    } catch {
      ownerToken = undefined;
    }
  }

  if (!ownerToken) {
    const issued = await requestJson(`${instance.openwork.url.replace(/\/$/, "")}/tokens`, {
      method: "POST",
      headers: { "X-OpenWork-Host-Token": instance.openwork.hostToken },
      body: { scope: "owner", label: `agent-lab:${instance.id}` },
      timeoutMs: 8000,
    });
    const token = String(issued?.token ?? "").trim();
    if (!token) throw new Error("owner_token_missing");
    ownerToken = token;
    instance.openwork.ownerToken = token;
    await saveInstance(dir, instance);
  }

  const collaboratorConnect: ConnectArtifact = {
    kind: "openwork.connect.v1",
    hostUrl: instance.openwork.url,
    workspaceId,
    workspaceUrl: `${instance.openwork.url.replace(/\/$/, "")}/w/${encodeURIComponent(workspaceId)}`,
    token: instance.openwork.token,
    tokenScope: "collaborator",
    createdAt: Date.now(),
  };

  const ownerConnect: ConnectArtifact = {
    kind: "openwork.connect.v1",
    hostUrl: instance.openwork.url,
    workspaceId,
    workspaceUrl: `${instance.openwork.url.replace(/\/$/, "")}/w/${encodeURIComponent(workspaceId)}`,
    token: ownerToken,
    tokenScope: "owner",
    createdAt: Date.now(),
  };

  const connectPath = join(instance.dir, "connect.json");
  await writeFile(connectPath, JSON.stringify(collaboratorConnect, null, 2) + "\n", "utf8");

  console.log(JSON.stringify({
    ok: true,
    workspaceId,
    connect: {
      collaborator: collaboratorConnect,
      owner: ownerConnect,
    },
    ui: {
      collaborator: `${instance.openwork.url}/ui#token=${instance.openwork.token}`,
      owner: `${instance.openwork.url}/ui#token=${ownerToken}`,
    },
    scheduler: {
      automationsPath: agentLabAutomationsPath(instance.workspaceDir),
      logsDir: agentLabLogsDir(instance.workspaceDir),
      sync: `openwork-agent-lab --dir ${baseDir} scheduler sync ${instance.id}`,
      uninstall: `openwork-agent-lab --dir ${baseDir} scheduler uninstall ${instance.id}`,
    },
  }, null, 2));
}

async function stop(argv: string[]) {
  const baseDir = baseDirFromArgs(argv);
  const id = argv[0];
  if (!id) throw new Error("missing_instance_id");
  const dir = instanceDir(baseDir, id);
  const instance = await loadInstance(dir);
  const stopCommand = instance.openwrk?.stopCommand;
  if (!stopCommand) {
    throw new Error("missing_stop_command");
  }

  const parts = stopCommand.split(" ").filter(Boolean);
  const cmd = parts[0];
  const args = parts.slice(1);
  await new Promise<void>((resolveResult, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`stop_failed_${code}`));
        return;
      }
      resolveResult();
    });
  });

  console.log(JSON.stringify({ ok: true }, null, 2));
}

async function status(argv: string[]) {
  const baseDir = baseDirFromArgs(argv);
  const id = argv[0];
  if (!id) throw new Error("missing_instance_id");
  const dir = instanceDir(baseDir, id);
  const instance = await loadInstance(dir);
  const url = instance.openwork.url.replace(/\/$/, "");
  const health = await requestJson(`${url}/health`).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  let workspaceId: string | null = null;
  try {
    const workspaces = await requestJson(`${url}/workspaces`, { token: instance.openwork.token });
    workspaceId = String(workspaces?.activeId || (workspaces?.items?.[0]?.id ?? "")) || null;
  } catch {
    workspaceId = null;
  }
  console.log(JSON.stringify({ ok: true, instance: { id: instance.id, name: instance.name }, openwork: { url, health }, workspaceId }, null, 2));
}

async function open(argv: string[]) {
  const baseDir = baseDirFromArgs(argv);
  const id = argv[0];
  if (!id) throw new Error("missing_instance_id");
  const dir = instanceDir(baseDir, id);
  const instance = await loadInstance(dir);
  const requested = (readFlag(argv, "--scope") ?? "").trim();
  const scope = requested === "collaborator" || requested === "owner" ? requested : "owner";
  const token = scope === "owner"
    ? (instance.openwork.ownerToken?.trim() || instance.openwork.token)
    : instance.openwork.token;
  const url = `${instance.openwork.url.replace(/\/$/, "")}/ui#token=${token}`;
  console.log(url);
}

async function del(argv: string[]) {
  const baseDir = baseDirFromArgs(argv);
  const id = argv[0];
  if (!id) throw new Error("missing_instance_id");
  const dir = instanceDir(baseDir, id);
  if (!dir.startsWith(resolve(baseDir))) {
    throw new Error("unsafe_delete");
  }
  await rm(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true }, null, 2));
}

async function scheduler(argv: string[]) {
  const baseDir = baseDirFromArgs(argv);
  const sub = (argv[0] ?? "").trim();
  const id = argv[1];
  const dryRun = argv.includes("--dry-run");
  if (!sub || sub === "--help" || sub === "-h") {
    throw new Error("usage: scheduler <list|sync|uninstall|run|logs> <instanceId> [...]");
  }
  if (!id) throw new Error("missing_instance_id");

  const dir = instanceDir(baseDir, id);
  const instance = await loadInstance(dir);
  const prefix = `com.openwork.agentlab.${instance.id}.`;

  if (sub === "list") {
    const store = await readAutomationsFromWorkspace(instance.workspaceDir);
    const items = store.items.map((item) => {
      const label = launchdLabel(instance.id, item.id);
      const plist = launchdPlistPath(label);
      return {
        id: item.id,
        name: item.name,
        enabled: item.enabled,
        schedule: item.schedule,
        promptPreview: item.prompt.length > 160 ? item.prompt.slice(0, 160) + "..." : item.prompt,
        label,
        plist,
        installed: existsSync(plist),
        logPath: launchdLogPath(instance, item.id),
      };
    });
    console.log(JSON.stringify({ ok: true, items }, null, 2));
    return;
  }

  if (sub === "uninstall") {
    await ensureDir(launchAgentsDir());
    const entries = await readdir(launchAgentsDir(), { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".plist")) continue;
      const plist = join(launchAgentsDir(), entry.name);
      if (!dryRun) {
        runLaunchctl(["unload", plist]);
        await rm(plist, { force: true });
      }
      removed.push(plist);
    }
    console.log(JSON.stringify({ ok: true, removed, dryRun }, null, 2));
    return;
  }

  if (sub === "sync") {
    await ensureDir(launchAgentsDir());
    await ensureDir(join(instance.dir, "scheduler"));
    await ensureDir(agentLabLogsDir(instance.workspaceDir));

    const store = await readAutomationsFromWorkspace(instance.workspaceDir);
    const desired = store.items.filter((item) => item.enabled);
    const desiredLabels = new Set(desired.map((item) => launchdLabel(instance.id, item.id)));

    // Remove stale plists.
    const entries = await readdir(launchAgentsDir(), { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".plist")) continue;
      const label = entry.name.slice(0, -6);
      if (desiredLabels.has(label)) continue;
      const plist = join(launchAgentsDir(), entry.name);
      if (!dryRun) {
        runLaunchctl(["unload", plist]);
        await rm(plist, { force: true });
      }
      removed.push(plist);
    }

    const applied: string[] = [];
    for (const automation of desired) {
      const label = launchdLabel(instance.id, automation.id);
      const scriptPath = schedulerScriptPath(instance, automation.id);
      const plistPath = launchdPlistPath(label);
      const logPath = launchdLogPath(instance, automation.id);

      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `OPENWORK_URL=${bashQuote(instance.openwork.url.replace(/\/$/, ""))}`,
        `TOKEN=${bashQuote(instance.openwork.token)}`,
        `AUTOMATION_ID=${bashQuote(automation.id)}`,
        "",
        "WS_ID=$(curl -fsS -H \"Authorization: Bearer ${TOKEN}\" \"${OPENWORK_URL}/workspaces\" | node -e 'const fs=require(\"fs\"); const j=JSON.parse(fs.readFileSync(0,\"utf8\")); process.stdout.write(String(j.activeId||j.items?.[0]?.id||\"\"));')",
        "if [ -z \"${WS_ID}\" ]; then echo \"workspace_id_missing\" 1>&2; exit 1; fi",
        "curl -fsS -H \"Authorization: Bearer ${TOKEN}\" -H \"Content-Type: application/json\" -X POST \"${OPENWORK_URL}/workspace/${WS_ID}/agentlab/automations/${AUTOMATION_ID}/run\" -d '{}' >/dev/null",
        "echo \"ok $(date -u +%Y-%m-%dT%H:%M:%SZ) automation=${AUTOMATION_ID} workspace=${WS_ID}\"",
        "",
      ].join("\n");
      const plist = buildLaunchdPlistXml({ label, scriptPath, schedule: automation.schedule, logPath });

      if (!dryRun) {
        await ensureDir(dirname(scriptPath));
        await writeFile(scriptPath, script, "utf8");
        await writeFile(plistPath, plist, "utf8");
        runLaunchctl(["unload", plistPath]);
        runLaunchctl(["load", plistPath]);
      }

      applied.push(plistPath);
    }

    console.log(JSON.stringify({ ok: true, applied, removed, dryRun }, null, 2));
    return;
  }

  if (sub === "run") {
    const automationId = argv[2];
    if (!automationId) throw new Error("missing_automation_id");
    const baseUrl = instance.openwork.url.replace(/\/$/, "");
    const workspaces = await requestJson(`${baseUrl}/workspaces`, { token: instance.openwork.token, timeoutMs: 8000 });
    const workspaceId = String(workspaces?.activeId || (workspaces?.items?.[0]?.id ?? ""));
    if (!workspaceId) throw new Error("workspace_id_missing");
    const result = await requestJson(`${baseUrl}/workspace/${encodeURIComponent(workspaceId)}/agentlab/automations/${encodeURIComponent(automationId)}/run`, {
      token: instance.openwork.token,
      method: "POST",
      body: {},
      timeoutMs: 15_000,
    });
    console.log(JSON.stringify({ ok: true, result }, null, 2));
    return;
  }

  if (sub === "logs") {
    const automationId = argv[2];
    if (!automationId) throw new Error("missing_automation_id");
    const path = launchdLogPath(instance, automationId);
    if (!existsSync(path)) throw new Error("log_not_found");
    const content = await readFile(path, "utf8");
    console.log(content);
    return;
  }

  throw new Error(`unknown_scheduler_command: ${sub}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    console.log(usage());
    return;
  }
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "create") return await create(rest);
    if (cmd === "list") return await list(rest);
    if (cmd === "start") return await start(rest);
    if (cmd === "stop") return await stop(rest);
    if (cmd === "status") return await status(rest);
    if (cmd === "open") return await open(rest);
    if (cmd === "scheduler") return await scheduler(rest);
    if (cmd === "delete") return await del(rest);
    throw new Error(`unknown_command: ${cmd}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(msg);
    process.exit(1);
  }
}

await main();
