import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import electron from "electron";
import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk/v2";
import { install as installMicrosandbox, isInstalled as isMicrosandboxInstalled, Patch, Sandbox } from "microsandbox";

const { BrowserWindow } = electron;

const LOCAL_URL = "http://127.0.0.1:4096";
const HEALTH_POLL_MS = 20_000;
const SESSION_LIMIT = 200;
const OPENWORK_PORT = 8787;
const MICROSANDBOX_IMAGE = process.env.LABS_MICROSANDBOX_IMAGE || "node:current-bookworm";
const KERNEL_DIR = dirname(fileURLToPath(import.meta.url));
const OPENWORK_HOST_DIR = resolve(KERNEL_DIR, "../../openwork-host");
const OPENWORK_HOST_ENTRY = resolve(OPENWORK_HOST_DIR, "dist/index.js");
const SDK_DIR = resolve(KERNEL_DIR, "../node_modules/@opencode-ai/sdk");
const GUEST_START_PATH = resolve(KERNEL_DIR, "../runtime/guest-start.mjs");
const OPENCODE_CACHE_DIR = resolve(KERNEL_DIR, "../.cache/opencode-linux-arm64");
const OPENCODE_BINARY_PATH = resolve(OPENCODE_CACHE_DIR, "opencode");
const OPENCODE_VERSION = "1.3.13";
const HOME_DIR = process.env.HOME || "";
const HOST_OPENCODE_DATA_DIR = resolve(HOME_DIR, ".local/share/opencode");
const HOST_OPENCODE_CONFIG_DIR = resolve(HOME_DIR, ".config/opencode");

function stripTrailingSlash(input) {
  return String(input ?? "").replace(/\/+$/, "");
}

function withInferredProtocol(input) {
  if (/^[a-z]+:\/\//i.test(input)) return input;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(input)) {
    return `http://${input}`;
  }
  return `https://${input}`;
}

function normalizeBaseUrl(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return "";

  try {
    const url = new URL(withInferredProtocol(trimmed));
    if (/^localhost$/i.test(url.hostname)) {
      url.hostname = "127.0.0.1";
    }
    const path = stripTrailingSlash(url.pathname || "");
    const isLocal = /^(127\.0\.0\.1|0\.0\.0\.0)$/i.test(url.hostname);
    const isWorkspaceProxy = path.startsWith("/w/");
    if (isLocal) {
      url.pathname = isWorkspaceProxy ? path : "";
    } else {
      url.pathname = isWorkspaceProxy || path.endsWith("/opencode") ? path : `${path || ""}/opencode`;
    }
    return stripTrailingSlash(url.toString());
  } catch {
    return "";
  }
}

function describeError(error) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function unwrap(result) {
  if (result && typeof result === "object" && "data" in result) {
    if (result.data !== undefined) return result.data;
    throw new Error(describeError(result.error));
  }
  return result;
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.type !== "string") return null;
  return {
    type: raw.type,
    properties: raw.properties,
  };
}

function buildClient(baseUrl, token) {
  return createOpencodeClient({
    baseUrl,
    headers: token?.trim()
      ? {
          Authorization: `Bearer ${token.trim()}`,
        }
      : undefined,
  });
}

function broadcast(channel, payload) {
  const windows = typeof BrowserWindow?.getAllWindows === "function" ? BrowserWindow.getAllWindows() : [];
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
}

async function ensurePath(filePath) {
  await access(filePath);
  return filePath;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
    });
  });
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: token?.trim()
      ? {
          Authorization: `Bearer ${token.trim()}`,
        }
      : undefined,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function waitFor(predicate, timeoutMs, delayMs = 1_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await predicate();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function ensureLinuxOpencodeBinary() {
  try {
    return await ensurePath(OPENCODE_BINARY_PATH);
  } catch {
    await mkdir(OPENCODE_CACHE_DIR, { recursive: true });
    await run(
      "bash",
      [
        "-lc",
        `curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-arm64.tar.gz" | tar -xzf - -C "${OPENCODE_CACHE_DIR}"`,
      ],
      {},
    );
    return ensurePath(OPENCODE_BINARY_PATH);
  }
}

async function ensureMicrosandbox() {
  if (!isMicrosandboxInstalled()) {
    await installMicrosandbox();
  }
}

async function ensureOpenworkHostBuild() {
  try {
    return await ensurePath(OPENWORK_HOST_ENTRY);
  } catch {
    await run("pnpm", ["--filter", "openwork-host", "build"], {
      cwd: resolve(KERNEL_DIR, "../../.."),
    });
    return ensurePath(OPENWORK_HOST_ENTRY);
  }
}

async function ensureGuestAssets() {
  await ensurePath(SDK_DIR);
  await ensurePath(GUEST_START_PATH);
  await ensureLinuxOpencodeBinary();
}

async function maybeCopyPatch(source, target, options = {}) {
  try {
    await access(source);
    return Patch.copyFile(source, target, { replace: true, ...options });
  } catch {
    return null;
  }
}

async function createRepoSnapshot(repoPath, workspaceId) {
  const snapshotRoot = await mkdtemp(resolve(tmpdir(), `labs-${slugify(workspaceId)}-`));
  const snapshotPath = resolve(snapshotRoot, "repo");
  try {
    const { stdout } = await run(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: repoPath },
    );
    const files = stdout.split("\0").filter(Boolean);
    for (const relativePath of files) {
      const source = resolve(repoPath, relativePath);
      const destination = resolve(snapshotPath, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: false, dereference: true });
    }
  } catch {
    await cp(repoPath, snapshotPath, {
      recursive: true,
      dereference: true,
      filter: (source) => {
        const name = source.split(/[\\/]/).filter(Boolean).pop() ?? "";
        if (name.includes(".bun-build")) return false;
        return ![
          "node_modules",
          ".pnpm-store",
          ".next",
          ".turbo",
          "_worktrees",
          "sidecars",
          "dist",
          "build",
          "coverage",
          ".cache",
          "target",
          ".git",
        ].includes(name);
      },
    });
  }
  return { snapshotRoot, snapshotPath };
}

async function resolveOpenworkProxyBase(baseUrl, token) {
  const openworkBaseUrl = normalizeBaseUrl(baseUrl);
  const workspaces = await fetchJson(`${openworkBaseUrl}/workspaces`, token);
  const items = Array.isArray(workspaces.items)
    ? workspaces.items
    : Array.isArray(workspaces.workspaces)
      ? workspaces.workspaces
      : [];
  const workspace = items[0] ?? null;
  const workspaceId = typeof workspace?.id === "string" ? workspace.id.trim() : "";
  if (!workspaceId) {
    throw new Error("OpenWork server did not return an accessible workspace.");
  }
  return {
    serverType: "openwork",
    serverWorkspaceId: workspaceId,
    openworkBaseUrl,
    baseUrl: `${openworkBaseUrl}/w/${encodeURIComponent(workspaceId)}/opencode`,
  };
}

async function maybeResolveRemoteBase(workspace) {
  const normalized = { ...workspace };
  normalized.baseUrl = normalizeBaseUrl(normalized.baseUrl);
  if (!normalized.baseUrl) {
    throw new Error("Enter a valid server URL.");
  }

  const pathname = new URL(normalized.baseUrl).pathname;
  if (pathname.startsWith("/w/") || pathname.endsWith("/opencode")) {
    normalized.serverType = normalized.serverType === "unknown" ? "opencode" : normalized.serverType;
    return normalized;
  }

  try {
    const resolved = await resolveOpenworkProxyBase(normalized.baseUrl, normalized.token ?? null);
    return {
      ...normalized,
      baseUrl: resolved.baseUrl,
      serverType: resolved.serverType,
      serverWorkspaceId: resolved.serverWorkspaceId,
    };
  } catch {
    return {
      ...normalized,
      serverType: normalized.serverType === "unknown" ? "opencode" : normalized.serverType,
    };
  }
}

async function ensureOpenworkHostWorkspace(workspace) {
  if (!workspace.repoPath?.trim()) {
    throw new Error("Choose a repository folder for this workspace.");
  }

  const existing = runtimeState.hosts.get(workspace.id);
  if (existing) {
    return {
      ...workspace,
      baseUrl: existing.baseUrl,
      runtime: "openwork-host",
      kind: "local",
      hostPort: existing.hostPort,
      serverType: "opencode",
      serverWorkspaceId: null,
    };
  }

  await ensureOpenworkHostBuild();
  const hostPort = Number.isFinite(workspace.hostPort) && workspace.hostPort ? workspace.hostPort : await getFreePort();
  const child = spawn("node", [OPENWORK_HOST_ENTRY], {
    cwd: OPENWORK_HOST_DIR,
    env: {
      ...process.env,
      OPENWORK_HOST_PORT: String(hostPort),
      OPENWORK_HOST_WORKSPACE_DIR: workspace.repoPath.trim(),
      OPENWORK_HOST_MODEL_PROVIDER: process.env.OPENWORK_HOST_MODEL_PROVIDER,
      OPENWORK_HOST_MODEL_ID: process.env.OPENWORK_HOST_MODEL_ID,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${hostPort}`;
  await waitFor(() => fetchJson(`${baseUrl}/global/health`, null), 30_000, 1_000).catch((error) => {
    child.kill();
    throw new Error(`${describeError(error)}\n${output}`.trim());
  });

  runtimeState.hosts.set(workspace.id, {
    child,
    hostPort,
    baseUrl,
  });

  child.once("exit", () => {
    runtimeState.hosts.delete(workspace.id);
  });

  return {
    ...workspace,
    baseUrl,
    runtime: "openwork-host",
    kind: "local",
    hostPort,
    serverType: "opencode",
    serverWorkspaceId: null,
  };
}

async function ensureMicrosandboxWorkspace(workspace) {
  if (!workspace.repoPath?.trim()) {
    throw new Error("Choose a repository folder for this workspace.");
  }

  await ensureMicrosandbox();
  await ensureGuestAssets();

  const sandboxName = workspace.sandboxName?.trim() || `labs-${slugify(workspace.id)}`;
  const hostPort = Number.isFinite(workspace.hostPort) && workspace.hostPort ? workspace.hostPort : await getFreePort();
  const token = workspace.token?.trim() || `labs-${randomUUID()}`;
  const existing = runtimeState.locals.get(workspace.id);
  if (existing) {
    return {
      ...workspace,
      baseUrl: existing.baseUrl,
      token: existing.token,
      runtime: "microsandbox",
      kind: "local",
      hostPort: existing.hostPort,
      sandboxName: existing.sandboxName,
      serverType: "openwork",
      serverWorkspaceId: "default",
    };
  }

  const { snapshotRoot, snapshotPath } = await createRepoSnapshot(workspace.repoPath.trim(), workspace.id);
  const guestAuth = await Promise.all([
    maybeCopyPatch(resolve(HOST_OPENCODE_DATA_DIR, "auth.json"), "/persist/openwork/.local/share/opencode/auth.json", { mode: 0o600 }),
    maybeCopyPatch(resolve(HOST_OPENCODE_DATA_DIR, "mcp-auth.json"), "/persist/openwork/.local/share/opencode/mcp-auth.json", { mode: 0o600 }),
    maybeCopyPatch(resolve(HOST_OPENCODE_CONFIG_DIR, "opencode.json"), "/persist/openwork/.config/opencode/opencode.json", { mode: 0o600 }),
  ]).then((items) => items.filter(Boolean));

  let sandbox = null;
  try {
    sandbox = await Sandbox.create({
      name: sandboxName,
      image: MICROSANDBOX_IMAGE,
      replace: true,
      quietLogs: true,
      network: { policy: "allow-all" },
      ports: { [String(hostPort)]: OPENWORK_PORT },
      env: {
        LABS_OPENWORK_TOKEN: token,
        LABS_REMOTE_ACCESS: "1",
      },
      patches: [
        Patch.mkdir("/opt/labs"),
        Patch.mkdir("/opt/labs/node_modules/@opencode-ai"),
        Patch.mkdir("/persist/openwork/.local/share/opencode"),
        Patch.mkdir("/persist/openwork/.config/opencode"),
        Patch.copyDir(SDK_DIR, "/opt/labs/node_modules/@opencode-ai/sdk", { replace: true }),
        Patch.copyFile(GUEST_START_PATH, "/opt/labs/guest-start.mjs", {
          mode: 0o755,
          replace: true,
        }),
        Patch.copyFile(OPENCODE_BINARY_PATH, "/usr/local/bin/opencode", {
          mode: 0o755,
          replace: true,
        }),
        Patch.copyDir(snapshotPath, "/workspace/repo", { replace: true }),
        Patch.mkdir("/persist/openwork"),
        ...guestAuth,
      ],
      cmd: ["sh", "-lc", "sleep infinity"],
    });
    const proc = await sandbox.shellStream("cd /opt/labs && node /opt/labs/guest-start.mjs");
    void (async () => {
      while (await proc.recv()) {
        // keep process output flowing so the guest server can stay attached
      }
    })();
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }

  const openworkBaseUrl = `http://127.0.0.1:${hostPort}`;
  await waitFor(() => fetchJson(`${openworkBaseUrl}/health`, token), 240_000, 2_000);
  const resolved = await waitFor(() => resolveOpenworkProxyBase(openworkBaseUrl, token), 60_000, 1_500);
  runtimeState.locals.set(workspace.id, {
    sandbox,
    hostPort,
    sandboxName,
    token,
    baseUrl: resolved.baseUrl,
  });

  return {
    ...workspace,
    baseUrl: resolved.baseUrl,
    token,
    runtime: "microsandbox",
    kind: "local",
    hostPort,
    sandboxName,
    serverType: resolved.serverType,
    serverWorkspaceId: resolved.serverWorkspaceId,
  };
}

const runtimeState = {
  localRuntime: null,
  localBoot: null,
  workspaces: new Map(),
  locals: new Map(),
  hosts: new Map(),
};

async function ensureLocalServer() {
  if (runtimeState.localRuntime) {
    return { baseUrl: runtimeState.localRuntime.url };
  }

  if (runtimeState.localBoot) {
    return runtimeState.localBoot;
  }

  runtimeState.localBoot = (async () => {
    try {
      const client = buildClient(LOCAL_URL, null);
      await client.global.health();
      return { baseUrl: LOCAL_URL };
    } catch {
      const runtime = await createOpencode({ port: 4096 });
      runtimeState.localRuntime = {
        url: normalizeBaseUrl(runtime.server.url),
        close: () => runtime.server.close(),
      };
      return { baseUrl: runtimeState.localRuntime.url };
    }
  })();

  try {
    return await runtimeState.localBoot;
  } finally {
    runtimeState.localBoot = null;
  }
}

function getWorkspaceEntry(workspaceId) {
  return runtimeState.workspaces.get(workspaceId) ?? null;
}

async function startWorkspaceEvents(workspaceId, client) {
  const entry = getWorkspaceEntry(workspaceId);
  if (!entry || entry.eventLoopStarted) return;
  entry.eventLoopStarted = true;

  let reconnectDelay = 1_000;
  while (!entry.controller.signal.aborted) {
    try {
      const subscription = await client.event.subscribe(undefined, { signal: entry.controller.signal });
      reconnectDelay = 1_000;
      for await (const raw of subscription.stream) {
        if (entry.controller.signal.aborted) return;
        const event = normalizeEvent(raw);
        if (!event) continue;
        broadcast("labs:event", { workspaceId, event });
      }
    } catch (error) {
      if (entry.controller.signal.aborted) return;
      broadcast("labs:connection", {
        workspaceId,
        connection: {
          status: "disconnected",
          message: describeError(error),
        },
      });
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay));
      reconnectDelay = Math.min(reconnectDelay * 2, 8_000);
    }
  }
}

function cleanupWorkspaceEntry(workspaceId) {
  const entry = getWorkspaceEntry(workspaceId);
  if (!entry) return null;
  if (entry.healthInterval) {
    clearInterval(entry.healthInterval);
  }
  entry.controller.abort();
  runtimeState.workspaces.delete(workspaceId);
  return entry.workspace;
}

async function removeWorkspace(workspaceId) {
  const workspace = cleanupWorkspaceEntry(workspaceId);
  const local = runtimeState.locals.get(workspaceId) ?? null;
  runtimeState.locals.delete(workspaceId);
  const host = runtimeState.hosts.get(workspaceId) ?? null;
  runtimeState.hosts.delete(workspaceId);
  if (!workspace) return true;

  if (host?.child && !host.child.killed) {
    host.child.kill();
  }

  if (local?.sandbox) {
    try {
      await local.sandbox.kill().catch(() => {});
      await Sandbox.remove(local.sandboxName).catch(() => {});
    } catch {
      // ignore cleanup failures for removed workspaces
    }
    return true;
  }

  if (workspace.runtime === "microsandbox" && workspace.sandboxName) {
    try {
      const handle = await Sandbox.get(workspace.sandboxName);
      if (handle.status === "running") {
        await handle.kill();
      }
      await handle.remove();
    } catch {
      // ignore cleanup failures for removed workspaces
    }
  }

  return true;
}

async function listSessions(client) {
  return unwrap(await client.session.list({ roots: false, limit: SESSION_LIMIT }));
}

async function refreshWorkspace(workspaceId) {
  const entry = getWorkspaceEntry(workspaceId);
  if (!entry) {
    throw new Error("Workspace is not registered.");
  }

  try {
    const health = unwrap(await entry.client.global.health());
    if (health?.healthy === false) {
      throw new Error("Server reported unhealthy state.");
    }
    const sessions = await listSessions(entry.client);
    const payload = {
      connection: {
        status: "connected",
        message: "Connected",
      },
      sessions,
    };
    broadcast("labs:connection", { workspaceId, connection: payload.connection });
    return payload;
  } catch (error) {
    const payload = {
      connection: {
        status: "disconnected",
        message: describeError(error),
      },
      sessions: [],
    };
    broadcast("labs:connection", { workspaceId, connection: payload.connection });
    return payload;
  }
}

async function ensureWorkspace(workspace) {
  let normalized = { ...workspace };
  if (normalized.runtime === "openwork-host") {
    normalized = await ensureOpenworkHostWorkspace(normalized);
  } else if (normalized.kind === "local" || normalized.runtime === "microsandbox" || normalized.repoPath?.trim()) {
    normalized = await ensureMicrosandboxWorkspace(normalized);
  } else {
    normalized = await maybeResolveRemoteBase(normalized);
  }

  if (!normalized.baseUrl) {
    throw new Error(normalized.kind === "local"
      ? "Local runtime is unavailable."
      : "Enter a valid server URL.");
  }

  const configKey = JSON.stringify({
    baseUrl: normalized.baseUrl,
    token: normalized.token?.trim() ?? "",
    hostPort: normalized.hostPort ?? null,
    repoPath: normalized.repoPath?.trim() ?? null,
    sandboxName: normalized.sandboxName ?? null,
    serverType: normalized.serverType ?? "unknown",
  });
  const existing = getWorkspaceEntry(normalized.id);
  if (existing && existing.configKey === configKey) {
    return { workspace: existing.workspace };
  }

  cleanupWorkspaceEntry(normalized.id);
  const controller = new AbortController();
  const client = buildClient(normalized.baseUrl, normalized.token ?? null);
  runtimeState.workspaces.set(normalized.id, {
    workspace: normalized,
    configKey,
    client,
    controller,
    healthInterval: null,
    eventLoopStarted: false,
  });

  const entry = getWorkspaceEntry(normalized.id);
  void startWorkspaceEvents(normalized.id, client);
  entry.healthInterval = setInterval(() => {
    void refreshWorkspace(normalized.id);
  }, HEALTH_POLL_MS);
  const refreshed = await refreshWorkspace(normalized.id);
  return {
    workspace: normalized,
    connection: refreshed.connection,
    sessions: refreshed.sessions,
  };
}

async function getSessionMessages(workspaceId, sessionId) {
  const entry = getWorkspaceEntry(workspaceId);
  if (!entry) {
    throw new Error("Workspace is not connected.");
  }
  return unwrap(await entry.client.session.messages({ sessionID: sessionId, limit: SESSION_LIMIT }));
}

async function createSession(workspaceId, options = {}) {
  const entry = getWorkspaceEntry(workspaceId);
  if (!entry) {
    throw new Error("Workspace is not connected.");
  }

  const created = unwrap(await entry.client.session.create({}));
  const nextTitle = String(options.title ?? "").trim();
  if (!nextTitle) {
    return created;
  }

  try {
    return unwrap(await entry.client.session.update({ sessionID: created.id, title: nextTitle }));
  } catch {
    return {
      ...created,
      title: nextTitle,
    };
  }
}

async function sendPrompt(workspaceId, sessionId, prompt) {
  const entry = getWorkspaceEntry(workspaceId);
  if (!entry) {
    throw new Error("Workspace is not connected.");
  }
  const trimmed = String(prompt ?? "").trim();
  if (!trimmed) return { sessionId };

  let resolvedSessionId = sessionId;
  if (!resolvedSessionId) {
    const created = await createSession(workspaceId);
    resolvedSessionId = created.id;
  }

  await unwrap(
    await entry.client.session.promptAsync({
      sessionID: resolvedSessionId,
      parts: [{ type: "text", text: trimmed }],
    }),
  );
  return { sessionId: resolvedSessionId };
}

async function abortSession(workspaceId, sessionId) {
  if (!sessionId) return;
  const entry = getWorkspaceEntry(workspaceId);
  if (!entry) {
    throw new Error("Workspace is not connected.");
  }
  await entry.client.session.abort({ sessionID: sessionId });
}

function teardownKernel() {
  for (const workspaceId of runtimeState.workspaces.keys()) {
    cleanupWorkspaceEntry(workspaceId);
  }
  for (const [workspaceId] of runtimeState.locals.entries()) {
    runtimeState.locals.delete(workspaceId);
  }
  for (const [workspaceId, host] of runtimeState.hosts.entries()) {
    runtimeState.hosts.delete(workspaceId);
    if (host.child && !host.child.killed) {
      host.child.kill();
    }
  }
  runtimeState.localRuntime?.close();
  runtimeState.localRuntime = null;
}

export const labsKernel = {
  ensureLocalServer,
  ensureWorkspace,
  refreshWorkspace,
  removeWorkspace,
  getSessionMessages,
  createSession,
  sendPrompt,
  abortSession,
  teardownKernel,
};
