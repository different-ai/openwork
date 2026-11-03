import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Place, Seed } from "@openwork/env";
import { navigate } from "@openwork/cdp";
import { binaryVersion, prepareParityBinaries } from "../scripts/engine-parity-binaries.mjs";
import { stopChild } from "./openwork-server-cli.ts";

export const retainedHistoryText = "Keep this real v1 project note readable after the default OpenCode v2 migration.";

interface EngineStatus {
  engineOrigin: string;
  engineForced: boolean;
  chatRouting: boolean;
  running: boolean;
  version?: string;
  migration: { state: string; imported: number; total: number; backupPath?: string };
}

/** Arrange history with the real pinned v1 engine BEFORE an unpinned OpenWork host can migrate it. */
async function prepareHistory(binary: string, workspace: string, env: NodeJS.ProcessEnv) {
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  let spawnError: Error | undefined;
  child.once("error", error => { spawnError = error; });
  try {
    let origin: string | undefined;
    const deadline = Date.now() + 60_000;
    while (!origin && Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Source v1 engine exited before history preparation: ${output.slice(-2000)}`);
      origin = output.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (!origin) await delay(100);
    }
    if (!origin) throw new Error(`Source v1 engine did not report its URL: ${output.slice(-2000)}`);
    async function request(path: string, body?: unknown) {
      const response = await fetch(`${origin}${path}?directory=${encodeURIComponent(workspace)}`, {
        method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Source v1 ${path}: ${response.status} ${await response.text()}`);
      return response;
    }
    const session = await (await request("/session", { title: "An existing v1 project note" })).json() as { id: string };
    await request(`/session/${session.id}/message`, { noReply: true, parts: [{ type: "text", text: retainedHistoryText }] });
    const messages = await (await request(`/session/${session.id}/message`)).text();
    if (!messages.includes(retainedHistoryText)) throw new Error("The real v1 engine did not persist the source note");
    return { sessionId: session.id, messages };
  } finally {
    await stopChild(child);
  }
}

export async function automaticEngineForcePolicy(seed: Seed, { place }: { place: Place }) {
  // appWeb has no remote pre-start fixture hook yet. Never arrange a local DB
  // and pretend the Daytona host consumed it, or silently test another source ref.
  if (place.kind !== "local") throw new Error("Default migration proof requires local headless appWeb placement: remote appWeb has no pre-host history preparation hook.");
  const binaries = await prepareParityBinaries(fileURLToPath(new URL("../../", import.meta.url))) as {
    OPENWORK_OPENCODE_BIN: string; OPENWORK_OPENCODE2_BIN: string;
  };
  const profile = seed.tmpPath("automatic-engine-history");
  const temporaryWorkspace = seed.tmpPath("automatic-engine-force-policy");
  await mkdir(temporaryWorkspace, { recursive: true });
  const workspacePath = await realpath(temporaryWorkspace);
  const isolated = {
    HOME: join(profile, "home"), USERPROFILE: join(profile, "home"),
    XDG_CONFIG_HOME: join(profile, "config"), XDG_DATA_HOME: join(profile, "data"),
    XDG_CACHE_HOME: join(profile, "cache"), XDG_STATE_HOME: join(profile, "state"),
    OPENCODE_CONFIG_DIR: join(profile, "config", "opencode"),
    OPENCODE_DB: join(profile, "data", "opencode", "opencode.db"),
  };
  await Promise.all(Object.values(isolated).filter(path => !path.endsWith(".db")).map(path => mkdir(path, { recursive: true })));
  await mkdir(join(profile, "data", "opencode"), { recursive: true });
  // Do not inherit this agent's OpenCode config, providers, credentials or policy.
  const executable = Object.fromEntries(["PATH", "TMPDIR", "SHELL", "SYSTEMROOT"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  const engineVersions = {
    v1: await binaryVersion(binaries.OPENWORK_OPENCODE_BIN),
    v2: await binaryVersion(binaries.OPENWORK_OPENCODE2_BIN),
  };
  const source = { ...await prepareHistory(binaries.OPENWORK_OPENCODE_BIN, workspacePath, { ...executable, ...isolated }), version: engineVersions.v1 };
  const token = randomUUID();
  const hostToken = randomUUID();
  const app = await seed.appWeb({
    name: "automatic-engine-force-policy", workspacePath, emptyWorkspace: true,
    env: { ...isolated, ...binaries, OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken,
      // No Den, force-policy, auto-upgrade or fresh-engine setting is supplied.
      // Remove appWeb's test-only v1/v2 preview selector: this is a default boot.
      OPENWORK_ENGINE_V2_PREVIEW: "" },
  });
  // Leave the host idle while it copies existing history. Creating/opening a
  // workspace here can create a new v1 draft during the copy and correctly
  // trigger the production source-change safety check.
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${app.openworkUrl}${path}`, {
      ...init, headers: { Authorization: `Bearer ${token}`, "x-openwork-host-token": hostToken,
        "Content-Type": "application/json", ...init.headers }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
    return response;
  }
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    const status: EngineStatus = await (await request("/experimental/engine-v2-preview/status")).json();
    if (status.migration.state === "error") throw new Error(`Default migration failed before the workspace opened: ${JSON.stringify(status)}`);
    if (status.running && status.chatRouting && status.migration.state === "completed") { ready = true; break; }
    await delay(250);
  }
  if (!ready) throw new Error("Default migration did not complete before opening the prepared chat");
  // appWeb cannot use the desktop's native folder picker. Register this fixture's
  // existing directory through the shipping host API, only AFTER the real v2
  // engine and copied history are ready (not an engine-less workspace seed).
  const workspace = await (await request("/workspaces/local", {
    method: "POST", body: JSON.stringify({ folderPath: workspacePath, name: "Existing v1 project" }),
  })).json() as { activeId: string };
  await request(`/workspaces/${workspace.activeId}/activate`, { method: "POST", body: JSON.stringify({ persist: true }) });
  const sessionPath = `/workspace/${workspace.activeId}/opencode2/api/session/${source.sessionId}`;
  await navigate(app.client, `${app.webUrl.replace(/\/$/, "")}/workspace/${workspace.activeId}/session/${source.sessionId}`);
  return {
    app, source, engineVersions,
    async status(): Promise<EngineStatus> {
      return (await request("/experimental/engine-v2-preview/status")).json();
    },
    async messages(): Promise<string> {
      return (await request(`${sessionPath}/message?limit=200`)).text();
    },
    async sendLegacyOptOut(): Promise<void> {
      await request("/experimental/engine-v2-preview/force", { method: "POST", body: JSON.stringify({ upgrade: false }) });
    },
  };
}
