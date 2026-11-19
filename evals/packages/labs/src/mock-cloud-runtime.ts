import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a JSON object");
  return value;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) raw += String(chunk);
  return raw ? record(JSON.parse(raw)) : {};
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function scriptUpload(request: IncomingMessage) {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Invalid upload bytes");
      chunks.push(chunk);
    }
    const contentType = request.headers["content-type"];
    if (!contentType?.startsWith("multipart/form-data;")) throw new Error("Missing multipart content type");
    const form = await new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { "content-type": contentType } }).formData();
    const path = form.get("files[0].path");
    const file = form.get("files[0].file");
    if (typeof path !== "string" || !file || typeof file === "string" || form.has("files[1].path")) {
      throw new Error("Invalid script upload fields");
    }
    return { path, script: await file.text() };
  } catch {
    throw new Error("Invalid witness script upload");
  }
}

type Session = { id: string; sandboxId: string; title: string; prompts: string[] };
type Sandbox = {
  id: string; name: string; workerId: string; snapshot: string;
  labels: Record<string, unknown>; bootstrapWorkerIds: string[];
  state: "started" | "stopped" | "destroying" | "destroyed";
  volumes: Array<{ volumeId: string; mountPath: string; subpath: string }>;
  purpose: string; endpoint: number; restored: boolean; sessions: Session[];
};

/**
 * Stateful Daytona SDK HTTP witness, not a Linux runtime. Bootstrap/flush/restore
 * commands are recognized but never executed; checkpoints model native sessions
 * in memory. This proves Den's orchestration, not tar/SQLite/volume durability.
 * Events retain only operation outcomes, never bootstrap commands or tokens.
 */
export async function startCloudRuntimeWitness() {
  const sandboxes: Sandbox[] = [];
  const events: Array<{
    sandboxId: string; operation: string; exitCode?: number | null; workerId?: string;
    sandboxIds?: string[]; cursor?: string | null; nextCursor?: string | null;
  }> = [];
  const commands = new Map<string, { exitCode: number | null }>();
  const directories = new Map<string, string>();
  const scripts = new Map<string, { script: string; mode: string | null; directoryMode: string }>();
  const credentialValues = new Set<string>();
  const stagingPath = /^\/tmp\/openwork-exec-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/script\.sh)?$/;
  const fileEvents: Array<{ sandboxId: string; operation: string; path: string; mode?: string }> = [];
  const commandTransports: Array<{
    sandboxId: string; operation: string; pathOnly: boolean; rawScript: boolean; runAsync: boolean;
    credentialValuesInCommand: boolean; credentialNames: string[]; suppressInputEcho: boolean;
    directoryMode: string | null; fileMode: string | null; selfUnlink: boolean;
  }> = [];
  const checkpoints = new Map<string, Session[]>();
  const failedRestores = new Set<string>();
  const deletionFaults = new Map<string, "fail" | "retain">();
  const listedExtras = new Set<string>();
  let recoveryFailure: { sandboxId: string; workerId: string; replacementAttempted: boolean } | null = null;
  const held = new Set<string>();
  // Instances whose OpenWork server reports a running session or a waiting
  // request, and instances whose `/health` misses while the server still answers.
  const busy = new Map<string, { busySessions: number; waitingRequests: number }>();
  const slowHealth = new Set<string>();
  const activityProbes: Array<{ sandboxId: string; authenticated: boolean }> = [];
  const unexpected: string[] = [];
  let nextSession = 0;
  let healthy = false;
  let sessionError: { code: string; message: string } | null = null;
  let url = "";

  function sandboxDto(sandbox: Sandbox) {
    return {
      id: sandbox.id, name: sandbox.name, state: sandbox.state, target: "test",
      toolboxProxyUrl: `${url}/toolbox`, labels: sandbox.labels,
    };
  }

  function sandboxById(id: string) {
    const sandbox = sandboxes.find((entry) => entry.id === id);
    if (!sandbox) throw new Error(`Unknown witness sandbox: ${id}`);
    return sandbox;
  }

  function checkpointKey(sandbox: Sandbox) {
    const mount = sandbox.volumes.find((entry) => entry.subpath.endsWith("/data") || entry.subpath.endsWith("/checkpoints"));
    if (!mount) throw new Error("Missing checkpoint mount");
    return `${mount.volumeId}:${mount.subpath.replace(/\/checkpoints$/, "")}/checkpoints`;
  }

  function scriptCredentials(script: string) {
    return Array.from(script.matchAll(/\b(OPENWORK_TOKEN|OPENWORK_HOST_TOKEN|DEN_ACTIVITY_HEARTBEAT_TOKEN)='((?:[^']|'"'"')*)'/g), (match) => ({
      name: match[1], value: match[2].replaceAll("'\"'\"'", "'"),
    }));
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const path = requestUrl.pathname;
    const method = request.method ?? "GET";
    if (method === "GET" && /\/volumes?\//.test(path)) {
      return json(response, 200, { id: "volume_witness", name: "witness", state: "ready" });
    }
    if (method === "GET" && path === "/sandbox") {
      const labels = record(JSON.parse(requestUrl.searchParams.get("labels") ?? "{}"));
      const matches = sandboxes.filter((entry) => entry.state !== "destroyed" && (
        listedExtras.has(entry.id) || Object.entries(labels).every(([key, value]) => entry.labels[key] === value)
      ));
      // Small, live pages expose callers that delete before exhausting the SDK iterator.
      const cursor = requestUrl.searchParams.get("cursor");
      const offset = cursor === null ? 0 : Number(cursor);
      const items = matches.slice(offset, offset + 1);
      const nextCursor = offset + 1 < matches.length ? String(offset + 1) : null;
      events.push({ sandboxId: "", operation: "list", sandboxIds: items.map((entry) => entry.id), cursor, nextCursor,
        workerId: typeof labels["openwork.den.worker-id"] === "string" ? labels["openwork.den.worker-id"] : undefined });
      return json(response, 200, { items: items.map(sandboxDto), nextCursor });
    }
    if (method === "POST" && path === "/sandbox") {
      const input = await body(request);
      const env = record(input.env);
      const workerId = typeof env.DEN_WORKER_ID === "string" ? env.DEN_WORKER_ID : "";
      if (workerId && recoveryFailure?.workerId === workerId) {
        recoveryFailure.replacementAttempted = true;
        events.push({ sandboxId: "", workerId, operation: "create-rejected" });
        return json(response, 503, { message: "Witness worker creation unavailable" });
      }
      if (sandboxes.some((entry) => entry.name === input.name && entry.state !== "destroyed")) {
        return json(response, 409, { message: "Sandbox with name already exists" });
      }
      const sandbox: Sandbox = {
        id: `sandbox_${sandboxes.length + 1}`, name: String(input.name),
        workerId,
        labels: record(input.labels), bootstrapWorkerIds: [],
        snapshot: String(input.snapshot), purpose: String(env.DEN_RUNTIME_PROVIDER),
        state: "started", endpoint: 0, restored: false, sessions: [],
        volumes: (Array.isArray(input.volumes) ? input.volumes : []).map((value) => {
          const mount = record(value);
          return { volumeId: String(mount.volumeId), mountPath: String(mount.mountPath), subpath: String(mount.subpath) };
        }),
      };
      sandboxes.push(sandbox);
      events.push({ sandboxId: sandbox.id, operation: "create" });
      return json(response, 201, sandboxDto(sandbox));
    }
    const preview = path.match(/^\/sandbox\/([^/]+)\/.*preview/);
    if (method === "GET" && preview) {
      const sandbox = sandboxById(preview[1]);
      if (sandbox.state === "destroyed") return json(response, 404, { message: "Sandbox not found" });
      if (recoveryFailure?.sandboxId === sandbox.id && !recoveryFailure.replacementAttempted) {
        events.push({ sandboxId: sandbox.id, operation: "endpoint-rejected" });
        return json(response, 503, { message: "Witness endpoint issuance unavailable" });
      }
      events.push({ sandboxId: sandbox.id, operation: "endpoint" });
      return json(response, 200, { url: `${url}/runtime/${sandbox.id}/endpoint_${++sandbox.endpoint}` });
    }
    const transition = path.match(/^\/sandbox\/([^/]+)\/(start|stop)$/);
    if (method === "POST" && transition) {
      const sandbox = sandboxById(transition[1]);
      if (sandbox.state === "destroyed") return json(response, 404, { message: "Sandbox not found" });
      sandbox.state = transition[2] === "start" ? "started" : "stopped";
      events.push({ sandboxId: sandbox.id, operation: transition[2] });
      return json(response, 200, sandboxDto(sandbox));
    }
    const lookup = path.match(/^\/sandbox\/([^/]+)$/);
    if (lookup && (method === "GET" || method === "DELETE")) {
      const sandbox = sandboxes.find((entry) => (entry.id === lookup[1] || entry.name === lookup[1]) && entry.state !== "destroyed");
      if (sandbox && method === "DELETE") {
        const fault = deletionFaults.get(sandbox.id);
        if (fault === "fail") {
          events.push({ sandboxId: sandbox.id, operation: "destroy-rejected" });
          return json(response, 503, { message: "Witness deletion unavailable" });
        }
        sandbox.state = fault === "retain" ? "destroying" : "destroyed";
        events.push({ sandboxId: sandbox.id, operation: fault === "retain" ? "destroy-pending" : "destroy" });
      }
      return json(response, sandbox ? 200 : 404, sandbox ? sandboxDto(sandbox) : { message: "Sandbox not found" });
    }
    const filesystem = path.match(/^\/toolbox\/([^/]+)\/files(\/folder|\/bulk-upload|\/permissions)?$/);
    if (filesystem) {
      const sandbox = sandboxById(filesystem[1]);
      if (sandbox.state !== "started") return json(response, 404, { message: "Sandbox filesystem unavailable" });
      const route = filesystem[2] ?? "";
      if (method === "POST" && route === "/bulk-upload") {
        const uploaded = await scriptUpload(request);
        if (!stagingPath.test(uploaded.path) || !uploaded.path.endsWith("/script.sh")) throw new Error("Invalid script staging path");
        const directory = uploaded.path.slice(0, uploaded.path.lastIndexOf("/"));
        const directoryMode = directories.get(`${sandbox.id}:${directory}`);
        if (directoryMode !== "700") throw new Error("Script upload requires a private directory");
        scripts.set(`${sandbox.id}:${uploaded.path}`, { script: uploaded.script, mode: null, directoryMode });
        for (const credential of scriptCredentials(uploaded.script)) {
          if (credential.value) credentialValues.add(credential.value);
        }
        fileEvents.push({ sandboxId: sandbox.id, operation: "upload", path: uploaded.path });
        return json(response, 200, {});
      }
      const remotePath = requestUrl.searchParams.get("path");
      if (!remotePath || !stagingPath.test(remotePath)) throw new Error("Invalid script staging path");
      const key = `${sandbox.id}:${remotePath}`;
      const mode = requestUrl.searchParams.get("mode");
      if (method === "POST" && route === "/folder") {
        if (mode !== "700" || remotePath.endsWith("/script.sh")) throw new Error("Script staging requires a private directory");
        if (directories.has(key)) return json(response, 409, { message: "Directory already exists" });
        directories.set(key, mode);
        fileEvents.push({ sandboxId: sandbox.id, operation: "directory", path: remotePath, mode });
        return json(response, 200, {});
      }
      if (method === "POST" && route === "/permissions") {
        const script = scripts.get(key);
        if (!script) return json(response, 404, { message: "Script not found" });
        if (mode !== "600") throw new Error("Staged script must be private");
        script.mode = mode;
        fileEvents.push({ sandboxId: sandbox.id, operation: "permissions", path: remotePath, mode });
        return json(response, 200, {});
      }
      if (method === "DELETE" && route === "") {
        if (directories.has(key) && requestUrl.searchParams.get("recursive") !== "true") throw new Error("Directory deletion requires recursive mode");
        scripts.delete(key);
        if (requestUrl.searchParams.get("recursive") === "true") {
          for (const file of scripts.keys()) if (file.startsWith(`${key}/`)) scripts.delete(file);
          directories.delete(key);
        }
        fileEvents.push({ sandboxId: sandbox.id, operation: "delete", path: remotePath });
        return json(response, 200, {});
      }
    }
    const process = path.match(/^\/toolbox\/([^/]+)\/process\/session(.*)$/);
    if (process) {
      const sandbox = sandboxById(process[1]);
      if (sandbox.state !== "started") {
        events.push({ sandboxId: sandbox.id, operation: "process-unavailable" });
        return json(response, 404, { message: "Sandbox process unavailable" });
      }
      if (method === "POST" && process[2] === "") return json(response, 200, {});
      if (method === "POST" && path.endsWith("/exec")) {
        const input = await body(request);
        const command = String(input.command);
        const scriptPath = command.match(/^sh -lc 'exec sh (\/tmp\/openwork-exec-[0-9a-f-]+\/script\.sh)'$/)?.[1];
        const staged = scriptPath ? scripts.get(`${sandbox.id}:${scriptPath}`) : undefined;
        if (scriptPath && (!stagingPath.test(scriptPath) || !staged)) throw new Error("Staged script missing at launch");
        if (staged && staged.mode !== "600") throw new Error("Staged script is not private at launch");
        const directory = scriptPath?.slice(0, scriptPath.lastIndexOf("/"));
        const prefix = `set +xv\nrm -f -- "$0" || exit 1\nrmdir -- '${directory}' 2>/dev/null || true\n`;
        const selfUnlink = Boolean(staged?.script.startsWith(prefix));
        const source = staged?.script ?? command;
        if (scriptPath) {
          fileEvents.push({ sandboxId: sandbox.id, operation: "launch", path: scriptPath });
          if (selfUnlink) {
            scripts.delete(`${sandbox.id}:${scriptPath}`);
            directories.delete(`${sandbox.id}:${directory}`);
            fileEvents.push({ sandboxId: sandbox.id, operation: "self-unlink", path: scriptPath });
          }
        }
        let operation: string;
        let exitCode: number | null;
        if (input.runAsync === true && source.includes("openwork-server")) {
          operation = "bootstrap";
          exitCode = null;
          const workerId = source.match(/DEN_WORKER_ID=[^a-z0-9]*([a-z0-9_]+)/)?.[1];
          if (!workerId) throw new Error("Bootstrap worker identity missing");
          sandbox.bootstrapWorkerIds.push(workerId);
          const checkpoint = checkpoints.get(checkpointKey(sandbox));
          if (sandbox.sessions.length === 0 && checkpoint && !failedRestores.delete(sandbox.workerId)) {
            sandbox.sessions = checkpoint.map((session) => ({ ...session, sandboxId: sandbox.id, prompts: [...session.prompts] }));
            sandbox.restored = true;
          }
        } else if (sandbox.purpose === "daytona-checkpoint-probe" && command.includes("ckpt-*.tar")) {
          operation = "checkpoint-probe";
          exitCode = checkpoints.has(checkpointKey(sandbox)) ? 0 : 1;
        } else if (command.includes("test -s") && command.includes(".openwork-restore-marker")) {
          operation = "restore-verify";
          exitCode = sandbox.restored ? 0 : 1;
        } else if (command.includes("flush_checkpoint") && input.runAsync === false) {
          operation = "checkpoint-flush";
          checkpoints.set(checkpointKey(sandbox), structuredClone(sandbox.sessions));
          exitCode = 0;
        } else if (sandbox.purpose === "daytona-cleanup" && command.includes("node -e") && command.includes("fs.rmSync")) {
          operation = "erase-data";
          for (const mount of sandbox.volumes) {
            for (const key of checkpoints.keys()) {
              if (key.startsWith(`${mount.volumeId}:${mount.subpath}/`)) checkpoints.delete(key);
            }
          }
          exitCode = 0;
        } else {
          throw new Error(`Unimplemented witness command for ${sandbox.id}`);
        }
        commandTransports.push({
          sandboxId: sandbox.id, operation, pathOnly: Boolean(scriptPath), runAsync: input.runAsync === true,
          rawScript: Boolean(staged && selfUnlink && source.slice(prefix.length).startsWith("set -u\n")),
          credentialValuesInCommand: Array.from(credentialValues).some((value) => command.includes(value))
            || /\b(?:OPENWORK_TOKEN|OPENWORK_HOST_TOKEN|DEN_ACTIVITY_HEARTBEAT_TOKEN)=/.test(command),
          credentialNames: scriptCredentials(source).map((credential) => credential.name),
          suppressInputEcho: input.suppressInputEcho === true,
          directoryMode: staged?.directoryMode ?? null, fileMode: staged?.mode ?? null, selfUnlink,
        });
        const cmdId = `cmd_${commands.size + 1}`;
        commands.set(path.replace(/\/exec$/, `/command/${cmdId}`), { exitCode });
        events.push({ sandboxId: sandbox.id, operation, exitCode });
        return json(response, 200, { cmdId });
      }
      if (method === "GET" && commands.has(path.replace(/\/logs$/, ""))) {
        return json(response, 200, path.endsWith("/logs") ? { stdout: "", stderr: "" } : commands.get(path));
      }
    }
    const runtime = path.match(/^\/runtime\/([^/]+)\/endpoint_(\d+)(.*)$/);
    if (runtime) {
      const sandboxId = runtime[1];
      const sandbox = sandboxById(sandboxId);
      const route = runtime[3];
      if (Number(runtime[2]) !== sandbox.endpoint) return json(response, 410, { message: "Preview expired" });
      if (!healthy || held.has(sandboxId) || sandbox.state !== "started") return json(response, 503, { ready: false });
      if (route === "/health") return json(response, slowHealth.has(sandboxId) ? 503 : 200, { ready: !slowHealth.has(sandboxId) });
      if (method === "GET" && route === "/runtime/activity") {
        const token = request.headers["x-openwork-host-token"];
        const authenticated = typeof token === "string" && credentialValues.has(token);
        activityProbes.push({ sandboxId, authenticated });
        if (!authenticated) return json(response, 401, { error: "unauthorized" });
        const load = busy.get(sandboxId) ?? { busySessions: 0, waitingRequests: 0 };
        return json(response, 200, {
          ok: true, verdict: load.busySessions > 0 || load.waitingRequests > 0 ? "busy" : "idle",
          ...load, connectedClients: 0, workspaces: 1, checkedAt: new Date(0).toISOString(),
        });
      }
      if (route === "/workspaces") return json(response, 200, { activeId: "workspace_witness", items: [] });
      if (method === "POST" && route === "/workspace/workspace_witness/opencode/session") {
        if (sessionError) return json(response, 400, sessionError);
        const input = await body(request);
        const session = { id: `ses_witness_${++nextSession}`, sandboxId, title: String(input.title), prompts: [] };
        sandbox.sessions.push(session);
        events.push({ sandboxId, operation: "session-create" });
        return json(response, 200, { id: session.id, title: session.title, directory: "/workspace", time: { created: 1 } });
      }
      if (method === "GET" && route === "/workspace/workspace_witness/opencode/session/status") return json(response, 200, {});
      const thread = route.match(/^\/workspace\/workspace_witness\/opencode\/session\/([^/]+)(.*)$/);
      if (thread) {
        const session = sandbox.sessions.find((entry) => entry.id === thread[1]);
        if (!session) return json(response, 404, { message: "Session not found" });
        if (method === "POST" && thread[2] === "/prompt_async") {
          const input = await body(request);
          for (const part of Array.isArray(input.parts) ? input.parts : []) session.prompts.push(String(record(part).text));
          events.push({ sandboxId, operation: "prompt" });
          return json(response, 200, {});
        }
        if (method === "GET" && thread[2] === "") return json(response, 200, { id: session.id, title: session.title });
        if (method === "GET" && thread[2] === "/todo") return json(response, 200, []);
        if (method === "GET" && thread[2] === "/message") return json(response, 200, session.prompts.map((text, index) => ({
          info: { id: `msg_${index}`, role: "user" }, parts: [{ id: `part_${index}`, type: "text", text }],
        })));
      }
      // The isolated organization has no model providers to materialize.
      if (route === "/opencode/config") return json(response, 200, {});
    }
    unexpected.push(`${method} ${path}`);
    json(response, 404, { message: `Unimplemented witness route: ${method} ${path}` });
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      unexpected.push(error instanceof Error ? error.message : String(error));
      json(response, 500, { message: "Cloud witness failed" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cloud witness has no listening address");
  url = `http://127.0.0.1:${address.port}`;
  return {
    url, sandboxes, events, unexpected, checkpoints, deletionFaults, listedExtras, fileEvents, commandTransports,
    pendingScriptCount: () => scripts.size,
    get sessions() { return sandboxes.filter((entry) => entry.state !== "destroyed").flatMap((entry) => entry.sessions); },
    ready(id?: string) {
      if (id) held.delete(id);
      else healthy = true;
    },
    sessionFailure(error: { code: string; message: string } | null) { sessionError = error; },
    sleep(id: string) { sandboxById(id).state = "stopped"; held.add(id); },
    activityProbes,
    /** Make the instance report running sessions or waiting requests; `null` returns it to idle. */
    load(id: string, value: { busySessions: number; waitingRequests: number } | null) {
      sandboxById(id);
      if (value) busy.set(id, value);
      else busy.delete(id);
    },
    /** Make `/health` miss while every other route, including activity, still answers. */
    slowHealth(id: string, on: boolean) {
      sandboxById(id);
      if (on) slowHealth.add(id);
      else slowHealth.delete(id);
    },
    expireEndpoint(id: string) { sandboxById(id).endpoint += 1; },
    seedImage(id: string, snapshot: string) {
      const sandbox = sandboxById(id);
      sandbox.snapshot = snapshot;
      sandbox.name = `${sandbox.name}-${snapshot}`;
    },
    failNextRestore(workerId: string) { failedRestores.add(workerId); },
    failRecovery(id: string | null) {
      // Both faults survive SDK retries; helpers have no worker identity and still work.
      recoveryFailure = id === null ? null : { sandboxId: id, workerId: sandboxById(id).workerId, replacementAttempted: false };
    },
    seedCheckpoint(id: string) {
      const sandbox = sandboxById(id);
      const key = checkpointKey(sandbox);
      checkpoints.set(key, structuredClone(sandbox.sessions));
      return key;
    },
    seedOrphan(id: string) {
      const source = sandboxById(id);
      const orphan = { ...structuredClone(source), id: `sandbox_${sandboxes.length + 1}`, name: `${source.name}-orphan` };
      sandboxes.push(orphan);
      return orphan;
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
