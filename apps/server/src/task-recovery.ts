import { z } from "zod";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export const RECOVERY_INTERVAL_MS = 2_000;
export const RECOVERY_CONCURRENCY = 2;
/** Consecutive failed observations before a record is retried with backoff. */
export const RECOVERY_FAILURES_BEFORE_BACKOFF = 3;
const RECOVERY_MAX_BACKOFF_MS = 5 * 60_000;
/** A new prompt is watched this long for an interruption worth resuming. */
const OBSERVING_WINDOW_MS = 30_000;
const MAX_TASKS = 1_000;
const recordSchema = z.object({
  workspaceId: z.string(), directory: z.string(), sessionId: z.string(),
  phase: z.enum(["observing", "running", "blocked", "claimed"]),
  userId: z.string().nullable(), shutdown: z.boolean(),
});
type RecoveryRecord = z.infer<typeof recordSchema>;
// Journals written while OpenCode v1 ran carry `engine`; its tasks cannot resume.
const storedRecordSchema = recordSchema.extend({ engine: z.enum(["v1", "v2"]).optional() });
const store = createWorkspaceKvStore<RecoveryRecord[]>({
  tableName: "desktop_task_recovery", valueColumn: "state_json",
  parse: (json) => z.array(storedRecordSchema).max(MAX_TASKS).parse(JSON.parse(json))
    .flatMap(({ engine, ...record }) => engine === "v1" ? [] : [record]),
  serialize: JSON.stringify,
});
const RECOVERY_PROMPT = "Continue the interrupted task from the current state. First inspect the conversation and workspace to verify which actions already completed. Preserve completed work, do not repeat side effects, and finish only what remains. Stop and ask if an earlier action's outcome cannot be verified.";

/** One desktop server owns this journal; no transcript, prompt, or credentials are persisted. */
export async function createTaskRecovery(
  config: ServerConfig,
  request: (request: Request) => Promise<Response>,
  beforeResume: () => Promise<void> = async () => {},
  options: {
    /** False while the engine is not running: records wait instead of polling 503s. */
    engineAvailable?: () => boolean;
  } = {},
) {
  const records = new Map<string, RecoveryRecord>();
  const startup = new Set<string>();
  const recovered = new Set<string>();
  const ownedRequests = new WeakMap<Request, RecoveryRecord>();
  const admissions = new Map<string, Promise<unknown>>();
  const observingSince = new Map<string, number>();
  const failures = new Map<string, { count: number; retryAt: number }>();
  const key = (record: Pick<RecoveryRecord, "workspaceId" | "sessionId">) =>
    JSON.stringify([record.workspaceId, record.sessionId]);
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
    observingSince.delete(key(record)); failures.delete(key(record));
  };
  // Unavailable state still never grants permission to send; it only stops a
  // record that cannot be read from costing five engine reads every tick.
  const observationFailed = async (record: RecoveryRecord) => {
    const recordKey = key(record);
    const count = (failures.get(recordKey)?.count ?? 0) + 1;
    if (count >= RECOVERY_FAILURES_BEFORE_BACKOFF && record.phase === "observing" && !startup.has(recordKey)
      && Date.now() - (observingSince.get(recordKey) ?? 0) > OBSERVING_WINDOW_MS && current(record)) {
      // Only a successful read settles a watch, and it is past the window in
      // which a quick interruption would be resumed.
      remove(record); await persist(); return;
    }
    const delay = count < RECOVERY_FAILURES_BEFORE_BACKOFF ? 0
      : Math.min(RECOVERY_MAX_BACKOFF_MS, RECOVERY_INTERVAL_MS * 2 ** (count - RECOVERY_FAILURES_BEFORE_BACKOFF + 1));
    failures.set(recordKey, { count, retryAt: Date.now() + delay });
  };
  const call = async (record: RecoveryRecord, path: string, body?: unknown) => {
    const mount = `/workspace/${encodeURIComponent(record.workspaceId)}/opencode2/api`;
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
        return isRecord(payload) ? payload.data : payload;
      }),
      new Promise<never>((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("Recovery request timed out")), { once: true })),
    ]);
  };
  const observe = async (record: RecoveryRecord) => {
    const sessionPath = `/session/${encodeURIComponent(record.sessionId)}`;
    const [session, statuses, messages, permissions, questions] = await Promise.all([
      call(record, sessionPath), call(record, "/session/active"),
      call(record, `${sessionPath}/context`),
      call(record, `${sessionPath}/permission`),
      // Only this session's forms decide `blocked`; the workspace-wide list
      // pages every conversation the engine has and fails with any of them.
      call(record, `${sessionPath}/form`),
    ]);
    if (!isRecord(session) || !isRecord(statuses) || !Array.isArray(messages)
      || !Array.isArray(permissions) || !Array.isArray(questions)) throw new Error("Invalid recovery snapshot");
    const info = isRecord(session.info) ? session.info : session;
    const history = messages.filter(isRecord);
    const user = [...history].reverse().find((message) => message.type === "user");
    const assistant = history.slice(user ? history.indexOf(user) + 1 : history.length)
      .reverse().find((message) => message.type === "assistant");
    const status = statuses[record.sessionId];
    const active = isRecord(status) && ["busy", "retry", "running"].includes(String(status.type));
    // A delegated task can be waiting on a child permission while the root
    // remains busy. Do not resume its parent independently of that child.
    const delegated = history.some((message) => {
      if (!user || history.indexOf(message) <= history.indexOf(user)) return false;
      const parts = message.content;
      return Array.isArray(parts) && parts.some((part: unknown) => isRecord(part) && part.type === "tool"
        && ["task", "subagent"].includes(String(part.name))
        && isRecord(part.state) && ["pending", "running"].includes(String(part.state.status)));
    });
    const blocked = delegated || [...permissions, ...questions].some((item: unknown) => isRecord(item) && item.sessionID === record.sessionId);
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
    let snapshot: Awaited<ReturnType<typeof observe>>;
    try { snapshot = await observe(record); }
    catch (error) {
      await observationFailed(record);
      throw error;
    }
    failures.delete(key(record));
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
    await call(record, `/session/${encodeURIComponent(record.sessionId)}/prompt`, { text: RECOVERY_PROMPT });
    if (!current(record)) return;
    record.phase = "observing"; record.userId = null; record.shutdown = false;
    observingSince.set(key(record), Date.now());
    await persist();
  };
  const tick = () => {
    if (stopped) return Promise.resolve();
    if (ticking) return ticking;
    const now = Date.now();
    const batch = [...records.values()].filter((record) => {
      if (options.engineAvailable && !options.engineAvailable()) return false;
      const failure = failures.get(key(record));
      return !failure || failure.retryAt <= now;
    });
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
    async forward(workspace: WorkspaceInfo, path: string, req: Request, send: () => Promise<Response>) {
      if (workspace.workspaceType !== "local" || !["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return send();
      const match = path.replace(/^\/opencode2\/api/, "").match(/^\/session\/([^/]+)(.*)$/);
      if (!match) return send();
      const sessionId = decodeURIComponent(match[1]);
      const suffix = match[2];
      const owned = ownedRequests.get(req);
      const admissionKey = key({ workspaceId: workspace.id, sessionId });
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
      const record: RecoveryRecord = { workspaceId: workspace.id, directory: workspace.path, sessionId,
        phase: "observing", userId: null, shutdown: false };
      const previous = records.get(key(record));
      if (previous) remove(previous);
      const admission = req.method === "POST" && ["/prompt", "/command"].includes(suffix)
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
