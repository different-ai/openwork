import { z } from "zod";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export const RECOVERY_INTERVAL_MS = 2_000;
export const RECOVERY_CONCURRENCY = 2;
const MAX_TASKS = 1_000;
const recordSchema = z.object({
  workspaceId: z.string(), directory: z.string(), sessionId: z.string(),
  engine: z.enum(["v1", "v2"]),
  phase: z.enum(["observing", "running", "blocked", "claimed"]),
  userId: z.string().nullable(), shutdown: z.boolean(),
});
type RecoveryRecord = z.infer<typeof recordSchema>;
type Engine = RecoveryRecord["engine"];
const store = createWorkspaceKvStore<RecoveryRecord[]>({
  tableName: "desktop_task_recovery", valueColumn: "state_json",
  parse: (json) => z.array(recordSchema).max(MAX_TASKS).parse(JSON.parse(json)),
  serialize: JSON.stringify,
});
const RECOVERY_PROMPT = "Continue the interrupted task from the current state. First inspect the conversation and workspace to verify which actions already completed. Preserve completed work, do not repeat side effects, and finish only what remains. Stop and ask if an earlier action's outcome cannot be verified.";

/** One desktop server owns this journal; no transcript, prompt, or credentials are persisted. */
export async function createTaskRecovery(
  config: ServerConfig,
  request: (request: Request) => Promise<Response>,
  beforeResume: () => Promise<void> = async () => {},
) {
  const records = new Map<string, RecoveryRecord>();
  const startup = new Set<string>();
  const recovered = new Set<string>();
  const ownedRequests = new WeakMap<Request, RecoveryRecord>();
  const admissions = new Map<string, Promise<unknown>>();
  const observingSince = new Map<string, number>();
  const key = (record: Pick<RecoveryRecord, "workspaceId" | "engine" | "sessionId">) =>
    JSON.stringify([record.workspaceId, record.engine, record.sessionId]);
  for (const record of await store.get(config, "desktop") ?? []) {
    if (record.phase !== "running") continue;
    records.set(key(record), record);
    startup.add(key(record));
  }
  let stopped = false;
  let checkpointSignal: AbortSignal | undefined;
  let ticking: Promise<void> | undefined;
  let writes = Promise.resolve();
  let nextLaunch = 0;
  let cursor = 0;
  const persist = () => {
    const json = store.serialize([...records.values()]);
    writes = writes.catch(() => {}).then(() => store.setSerialized(config, "desktop", json, Date.now()));
    return writes;
  };
  const current = (record: RecoveryRecord) => !stopped && records.get(key(record)) === record;
  const remove = (record: RecoveryRecord) => {
    records.delete(key(record)); startup.delete(key(record)); recovered.delete(key(record));
    observingSince.delete(key(record));
  };
  const call = async (record: RecoveryRecord, path: string, body?: unknown) => {
    const mount = `/workspace/${encodeURIComponent(record.workspaceId)}/${record.engine === "v2" ? "opencode2/api" : "opencode"}`;
    const req = new Request(`http://127.0.0.1:${config.port}${mount}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: checkpointSignal
        ? AbortSignal.any([checkpointSignal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    });
    if (req.signal.aborted) throw new Error("Recovery request cancelled");
    ownedRequests.set(req, record);
    return Promise.race([
      request(req).then(async (response) => {
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Recovery request unavailable (${response.status})`);
        }
        if (body !== undefined) { await response.body?.cancel(); return null; }
        const payload: unknown = await response.json();
        return record.engine === "v2" && isRecord(payload) ? payload.data : payload;
      }),
      new Promise<never>((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("Recovery request timed out")), { once: true })),
    ]);
  };
  const observe = async (record: RecoveryRecord) => {
    const v2 = record.engine === "v2";
    const sessionPath = `/session/${encodeURIComponent(record.sessionId)}`;
    const [session, statuses, messages, permissions, questions, nativePermissions] = await Promise.all([
      call(record, sessionPath), call(record, v2 ? "/session/active" : "/session/status"),
      call(record, `${sessionPath}/${v2 ? "context" : "message?limit=100"}`),
      call(record, v2 ? `${sessionPath}/permission` : "/permission"),
      call(record, v2 ? "/form/request" : "/question"),
      v2 ? [] : call(record, `/api${sessionPath}/permission`),
    ]);
    if (!isRecord(session) || !isRecord(statuses) || !Array.isArray(messages)
      || !Array.isArray(permissions) || !Array.isArray(questions)) throw new Error("Invalid recovery snapshot");
    const extraPermissions = isRecord(nativePermissions) ? nativePermissions.data : nativePermissions;
    if (!Array.isArray(extraPermissions)) throw new Error("Invalid native permission snapshot");
    const info = isRecord(session.info) ? session.info : session;
    const history = messages.flatMap((message: unknown) => {
      if (!isRecord(message)) return [];
      const item = v2 ? message : message.info;
      return isRecord(item) ? [item] : [];
    });
    const user = [...history].reverse().find((message) => message[v2 ? "type" : "role"] === "user");
    const assistant = history.slice(user ? history.indexOf(user) + 1 : history.length)
      .reverse().find((message) => message[v2 ? "type" : "role"] === "assistant");
    const status = statuses[record.sessionId];
    const active = isRecord(status) && ["busy", "retry", "running"].includes(String(status.type));
    // A delegated task can be waiting on a child permission while the root
    // remains busy. Do not resume its parent independently of that child.
    const delegated = messages.some((message: unknown) => {
      if (!isRecord(message)) return false;
      const item = v2 ? message : message.info;
      if (!user || !isRecord(item) || history.indexOf(item) <= history.indexOf(user)) return false;
      const parts = v2 ? message.content : message.parts;
      return Array.isArray(parts) && parts.some((part: unknown) => isRecord(part) && part.type === "tool"
        && ["task", "subagent"].includes(String(v2 ? part.name : part.tool))
        && isRecord(part.state) && ["pending", "running"].includes(String(part.state.status)));
    });
    const blocked = delegated || [...permissions, ...extraPermissions, ...questions].some((item: unknown) => isRecord(item) && item.sessionID === record.sessionId);
    const archived = isRecord(info.time) && typeof info.time.archived === "number" && info.time.archived > 0;
    const completed = assistant && isRecord(assistant.time) && typeof assistant.time.completed === "number";
    const aborted = assistant && isRecord(assistant.error) && assistant.error.name === "MessageAbortedError";
    // Idle alone is not proof of interruption. Require the same unfinished turn,
    // or an abort produced after our own graceful-shutdown checkpoint.
    const unfinished = assistant && (!assistant.error && (!completed || assistant.finish === "tool-calls")
      || record.shutdown && aborted) || record.shutdown && info.outcome === "interrupted";
    const terminal = archived || info.outcome === "succeeded" || info.outcome === "failed"
      || Boolean(assistant?.error && !(record.shutdown && aborted));
    const activeCount = Object.values(statuses).filter((status) => isRecord(status)
      && ["busy", "retry", "running"].includes(String(status.type))).length;
    return { active, activeCount, blocked, terminal, unfinished: Boolean(unfinished),
      userId: typeof user?.id === "string" ? user.id : null, user };
  };
  const check = async (record: RecoveryRecord) => {
    const workspace = config.workspaces.find((workspace) => workspace.id === record.workspaceId);
    if (!workspace || workspace.workspaceType !== "local" || workspace.path !== record.directory || config.readOnly) {
      if (current(record)) { remove(record); await persist(); }
      return;
    }
    // Wait for restored sign-in/policy before claiming work. The actual send
    // still traverses the authenticated policy-enforcing proxy.
    if (startup.has(key(record))) await beforeResume();
    const snapshot = await observe(record);
    if (!current(record)) return;
    const pending = startup.has(key(record));
    if (record.phase === "claimed" && (snapshot.active || admissions.has(key(record)))) return;
    if (snapshot.terminal || (record.userId !== null && snapshot.userId !== record.userId)
      || (pending && snapshot.blocked)) {
      remove(record); await persist(); return;
    }
    if (snapshot.active || snapshot.blocked) {
      // An engine which recovered its own run is observed, never re-prompted.
      startup.delete(key(record));
      if (pending) recovered.add(key(record));
      record.phase = snapshot.blocked ? "blocked" : "running";
      record.userId = snapshot.userId;
      record.shutdown = false;
      await persist(); return;
    }
    if (!pending) {
      if (record.phase !== "observing" || Date.now() - (observingSince.get(key(record)) ?? 0) > 30_000) { remove(record); await persist(); }
      return;
    }
    if (!snapshot.unfinished || !record.userId) { remove(record); await persist(); return; }
    if (recovered.size >= RECOVERY_CONCURRENCY || snapshot.activeCount >= RECOVERY_CONCURRENCY || Date.now() < nextLaunch) return;
    // Claim durably before admission. A lost acknowledgement is never retried,
    // including across another process restart.
    record.phase = "claimed";
    startup.delete(key(record));
    recovered.add(key(record));
    nextLaunch = Date.now() + RECOVERY_INTERVAL_MS;
    await persist();
    if (!current(record)) return;
    const model = snapshot.user?.model;
    if (record.engine === "v1" && (!isRecord(model) || typeof model.providerID !== "string" || typeof model.modelID !== "string")) {
      remove(record); await persist(); return;
    }
    await call(record, `/session/${encodeURIComponent(record.sessionId)}/${record.engine === "v2" ? "prompt" : "prompt_async"}`,
      record.engine === "v2" ? { text: RECOVERY_PROMPT } : {
        parts: [{ type: "text", text: RECOVERY_PROMPT }], model,
        ...(typeof snapshot.user?.agent === "string" ? { agent: snapshot.user.agent } : {}),
        ...(typeof snapshot.user?.variant === "string" ? { variant: snapshot.user.variant } : {}),
      });
    if (!current(record)) return;
    record.phase = "observing"; record.userId = null; record.shutdown = false;
    observingSince.set(key(record), Date.now());
    await persist();
  };
  const tick = () => {
    if (stopped) return Promise.resolve();
    if (ticking) return ticking;
    const batch = [...records.values()];
    // Bound background reads as well as starts; rotate so a large backlog is fair.
    const selected = batch.length ? [batch[cursor % batch.length], batch[(cursor + 1) % batch.length]] : [];
    cursor += RECOVERY_CONCURRENCY;
    ticking = Promise.all([...new Set(selected)].map((record) => check(record).catch(() => {
      // Unavailable or ambiguous state never grants permission to send. A claimed
      // send retains its slot until a later observation establishes its outcome.
    }))).then(() => {}).finally(() => { ticking = undefined; });
    return ticking;
  };
  const timer = setInterval(() => void tick(), RECOVERY_INTERVAL_MS);
  timer.unref();
  return {
    tick,
    owns: (request: Request) => ownedRequests.has(request),
    async forward(workspace: WorkspaceInfo, engine: Engine, path: string, req: Request, send: () => Promise<Response>) {
      if (workspace.workspaceType !== "local" || !["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return send();
      const match = path.replace(/^\/opencode2\/api|^\/opencode/, "").match(/^\/session\/([^/]+)(.*)$/);
      if (!match) return send();
      const sessionId = decodeURIComponent(match[1]);
      const suffix = match[2];
      const owned = ownedRequests.get(req);
      const admissionKey = key({ workspaceId: workspace.id, engine, sessionId });
      const serializedSend = async () => {
        const previous = admissions.get(admissionKey);
        const operation = (previous ?? Promise.resolve()).catch(() => {}).then(() => {
          if (owned && (!current(owned) || req.signal.aborted)) throw new Error("Recovery admission cancelled");
          return send();
        });
        admissions.set(admissionKey, operation);
        try { return await operation; }
        finally { if (admissions.get(admissionKey) === operation) admissions.delete(admissionKey); }
      };
      if (owned) return serializedSend();
      // Permission replies may let a tracked blocked turn continue. All other
      // manual mutations invalidate recovery before the engine sees them.
      if (/^\/(permission|form)\//.test(suffix)) return serializedSend();
      const record: RecoveryRecord = { workspaceId: workspace.id, directory: workspace.path, engine, sessionId,
        phase: "observing", userId: null, shutdown: false };
      const previous = records.get(key(record));
      if (previous) remove(previous);
      const admission = req.method === "POST" && ["/prompt_async", "/prompt", "/command"].includes(suffix)
        && req.headers.get("x-openwork-task-recovery") !== "off";
      if (!stopped && admission && records.size < MAX_TASKS) {
        records.set(key(record), record);
        observingSince.set(key(record), Date.now());
      }
      await persist();
      const response = await serializedSend();
      if (current(record) && !response.ok) { remove(record); await persist(); }
      return response;
    },
    async stop() {
      if (stopped) return writes;
      clearInterval(timer);
      // Freeze before engines are killed, so their shutdown idle/error cannot
      // erase intent. In-flight observations are discarded by current().
      stopped = true;
      const candidates = [...records.values()].filter((record) => record.phase !== "claimed" && !startup.has(key(record)));
      // An unprocessed or unavailable final snapshot is not eligible. Checkpoint
      // at most two sessions at once, within one bounded shutdown window.
      for (const record of candidates) { record.phase = "blocked"; record.shutdown = false; }
      await persist();
      const deadline = Date.now() + 10_000;
      checkpointSignal = AbortSignal.timeout(10_000);
      let index = 0;
      await Promise.all(Array.from({ length: RECOVERY_CONCURRENCY }, async () => {
        while (index < candidates.length && Date.now() < deadline) {
          const record = candidates[index++];
          try {
            const snapshot = await observe(record);
            if (records.get(key(record)) === record && snapshot.active && !snapshot.blocked && !snapshot.terminal
              && snapshot.userId && (record.userId === null || snapshot.userId === record.userId)) {
              record.phase = "running"; record.shutdown = true; record.userId = snapshot.userId;
            }
          } catch { /* Leave unverified work excluded. */ }
        }
      }));
      await persist();
    },
  };
}

type TaskRecovery = Awaited<ReturnType<typeof createTaskRecovery>>;
const coordinators = new WeakMap<ServerConfig, TaskRecovery>();
export function setTaskRecovery(config: ServerConfig, recovery: TaskRecovery) { coordinators.set(config, recovery); }
export async function stopTaskRecovery(config: ServerConfig) { await coordinators.get(config)?.stop(); }
