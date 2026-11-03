import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Place, Seed } from "@openwork/env";
import { navigate } from "@openwork/cdp";
import { prepareParityBinaries } from "../scripts/engine-parity-binaries.mjs";
import { stopChild } from "./openwork-server-cli.ts";

export const savedChat = {
  id: "ses_00000000000000000000000101",
  title: "Quarterly planning notes",
};

interface EngineStatus {
  running: boolean;
  chatRouting: boolean;
  engineOrigin: string;
  lastError?: string;
}

interface Engine { child: ChildProcess; origin: string; password: string }

/** Run the pinned OpenCode v2 engine directly on the profile's v2 database, as an earlier OpenWork did. */
async function startEngine(binary: string, env: NodeJS.ProcessEnv): Promise<Engine> {
  const password = randomBytes(16).toString("hex");
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { env: { ...env, OPENCODE_PASSWORD: password }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const origin = output.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (origin) return { child, origin, password };
    if (child.exitCode !== null) throw new Error(`OpenCode v2 exited while arranging history: ${output.slice(-2000)}`);
    await delay(100);
  }
  await stopChild(child);
  throw new Error(`OpenCode v2 did not report its URL: ${output.slice(-2000)}`);
}

async function engineRequest(engine: Engine, path: string, directory: string, body?: unknown): Promise<string> {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`${engine.origin}${path}${separator}location%5Bdirectory%5D=${encodeURIComponent(directory)}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenCode v2 ${path}: ${response.status} ${text.slice(0, 500)}`);
  return text;
}

/**
 * The field state, in a disposable profile: a chat made on OpenCode v2, an
 * earlier history copy that published its fence and stopped without removing
 * it, and an engine left running by an OpenWork that exited, still holding
 * that history. Every earlier build then failed each start with
 * "History migration is incomplete. Resume it before opening OpenCode v2."
 */
export async function v2HistoryLockoutRecovery(seed: Seed, { place }: { place: Place }) {
  // appWeb has no remote pre-start fixture hook: the profile must be arranged on this machine.
  if (place.kind !== "local") throw new Error("The lockout recovery proof arranges the profile before the host starts; it needs local headless appWeb placement.");
  const binaries = await prepareParityBinaries(fileURLToPath(new URL("../../", import.meta.url))) as {
    OPENWORK_OPENCODE_BIN: string; OPENWORK_OPENCODE2_BIN: string;
  };
  const profile = seed.tmpPath("v2-history-lockout-profile");
  const workspaceDirectory = seed.tmpPath("v2-history-lockout-workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const workspacePath = await realpath(workspaceDirectory);
  const storage = join(profile, "runtime");
  const root = join(storage, "opencode-v2", "state");
  const isolated = {
    HOME: join(profile, "home"), USERPROFILE: join(profile, "home"),
    XDG_CONFIG_HOME: join(profile, "config"), XDG_DATA_HOME: join(profile, "data"),
    XDG_CACHE_HOME: join(profile, "cache"), XDG_STATE_HOME: join(profile, "state"),
    OPENCODE_DB: join(profile, "data", "opencode", "opencode.db"),
  };
  await Promise.all([root, isolated.HOME, isolated.XDG_CONFIG_HOME, isolated.XDG_DATA_HOME, isolated.XDG_CACHE_HOME, isolated.XDG_STATE_HOME,
    join(profile, "data", "opencode")].map(path => mkdir(path, { recursive: true })));
  const executable = Object.fromEntries(["PATH", "TMPDIR", "SHELL", "SYSTEMROOT"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  const engineEnv = { ...executable, ...isolated, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DB: join(root, "opencode.db") };

  // A chat made on OpenCode v2: a session row in this history, with its title.
  const seeding = await startEngine(binaries.OPENWORK_OPENCODE2_BIN, { ...engineEnv, OPENCODE_CONFIG_DIR: join(profile, "seed-config") });
  try {
    await engineRequest(seeding, "/api/session", workspacePath, { id: savedChat.id, title: savedChat.title, location: { directory: workspacePath } });
    const listed = await engineRequest(seeding, "/api/session", workspacePath);
    if (!listed.includes(savedChat.title)) throw new Error("OpenCode v2 did not persist the arranged chat");
  } finally { await stopChild(seeding.child); }

  // An engine whose OpenWork exited (its lease names a process that is gone).
  const orphan = await startEngine(binaries.OPENWORK_OPENCODE2_BIN, { ...engineEnv, OPENCODE_CONFIG_DIR: join(profile, "orphan-config") });
  const gone = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise<void>(done => gone.once("exit", () => done()));
  await writeFile(join(root, "engine-lease-orphan.json"), JSON.stringify({ pid: gone.pid, child: orphan.child.pid }));
  // The fence an interrupted copy left behind, in the format earlier builds wrote.
  await writeFile(join(root, "history-copy.pending"), "History copy must finish before the engine opens this database.\n");
  await writeFile(join(storage, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true, engineOrigin: "manual",
    engineChangedAt: "2026-10-01T00:00:00.000Z", engineForced: false }));

  const token = randomUUID();
  const hostToken = randomUUID();
  const app = await seed.appWeb({
    name: "v2-history-lockout-recovery", workspacePath, emptyWorkspace: true,
    env: { ...isolated, ...binaries, OPENWORK_RUNTIME_DB: join(storage, "runtime.sqlite"), OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken,
      // The saved engine choice decides, as on a person's computer.
      OPENWORK_ENGINE_V2_PREVIEW: "" },
  });
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${app.openworkUrl}${path}`, {
      ...init, headers: { Authorization: `Bearer ${token}`, "x-openwork-host-token": hostToken, "Content-Type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
    return response;
  }
  async function status(): Promise<EngineStatus> {
    return (await request("/experimental/engine-v2-preview/status")).json();
  }
  // Wait for the engine to settle either way; the spec judges the outcome.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const current = await status();
    if (current.running || current.lastError) break;
    await delay(250);
  }
  // appWeb has no native folder picker: register this folder through the host API.
  const workspace = await (await request("/workspaces/local", {
    method: "POST", body: JSON.stringify({ folderPath: workspacePath, name: "Planning" }),
  })).json() as { activeId: string };
  await request(`/workspaces/${workspace.activeId}/activate`, { method: "POST", body: JSON.stringify({ persist: true }) });
  await navigate(app.client, `${app.webUrl.replace(/\/$/, "")}/workspace/${workspace.activeId}/session`);
  return {
    app, status,
    arranged: { fence: true, leftoverEnginePid: orphan.child.pid, leaseOwnerExited: gone.exitCode !== null },
    fenceRemains: () => access(join(root, "history-copy.pending")).then(() => true, () => false),
    leftoverEngineRunning: () => orphan.child.exitCode === null && orphan.child.signalCode === null,
    async [Symbol.asyncDispose]() { await stopChild(orphan.child); },
  };
}
