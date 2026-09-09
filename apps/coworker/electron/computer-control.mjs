import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

export const COMPUTER_TOOLS = Object.freeze({
  coworker_computer_discover: "computer_discover",
  coworker_computer_open: "computer_open_session",
  coworker_computer_observe: "computer_observe",
  coworker_computer_act: "computer_act",
  coworker_computer_status: "computer_session_status",
  coworker_computer_close: "computer_close_session",
});
export const COMPUTER_DENY = Object.freeze(Object.fromEntries(Object.keys(COMPUTER_TOOLS).map((name) => [name, false])));
export const COMPUTER_PROTOCOL = "openwork.computer-use/1";
export const COMPUTER_STOP_GUIDANCE = "Computer session revocation could not be confirmed. Use Stop in the native Computer Use panel or the selected remote computer's session controls before continuing.";
const remoteReason = "A compatible remote service is not connected.";
const remote = Object.freeze({ id: "remote", label: "Remote computer", placement: "cloud", protocol: COMPUTER_PROTOCOL,
  readiness: async () => ({ readiness: "unavailable", detail: remoteReason }),
  setup: async () => { throw new Error(remoteReason); }, connect: async () => { throw new Error(remoteReason); } });
const failure = (code, message, extra = {}) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code, message, ...extra }) }] });
const stateOf = (result) => {
  try { return JSON.parse(result.content.find((part) => part.type === "text").text); } catch { return null; }
};
const needsPerson = (result) => stateOf(result)?.state === "paused" || stateOf(result)?.next === "human_takeover";
const withHandoff = (result, status) => {
  const state = stateOf(status);
  const continued = !status.isError && state?.ok === true && state.state === "active";
  return { ...result, isError: result.isError === true || !continued,
    content: [...result.content, { type: "text", text: JSON.stringify({ handoff: state, next: continued ? "observe" : "human_takeover", fresh_observation_required: true, actions_replayed: false }) }] };
};
const keyFor = (slug, threadId) => JSON.stringify([slug, threadId]);

export function assertPrivateComputerDiscussion({ slug, threadId, savedIds, workerIds, workers, groups, assignments, owners }) {
  if (!savedIds.includes(threadId) || workerIds.includes(threadId)
    || workers.some((worker) => worker.threadId === threadId)
    || groups.some((group) => group.participantThreadIds[slug] === threadId)
    || assignments.some((assignment) => assignment.runs.some((run) => run.threadId === threadId))
    || owners.some((owner) => owner.kind !== "private" || owner.conversationId !== threadId)) {
    throw new Error("Computer control is only available in an actual saved private discussion, not assignments, Workers, groups, or summaries.");
  }
}

/** The native part, not model arguments or the selected UI tab, supplies authority. */
export function assertComputerToolContext({ slug, context, name, args, entry, snapshot, workspaceId, active }) {
  const message = snapshot.messages.find((item) => item.id === context.messageID && item.role === "assistant");
  const part = message?.parts.find((item) => item.type === "tool" && item.callId === context.callID);
  const parent = snapshot.messages.find((item) => item.id === entry?.messageId && item.role === "user");
  if (!Object.hasOwn(COMPUTER_TOOLS, name) || !active || !entry?.personRequest || entry.continuation
    || entry.state !== "running" || !entry.sentAt || entry.owner.kind !== "private"
    || entry.owner.slug !== slug || entry.owner.threadId !== context.sessionID || entry.owner.conversationId !== context.sessionID
    || !workspaceId || workspaceId !== entry.workspaceId || snapshot.threadId !== context.sessionID
    || !context.directory || !snapshot.directory || path.resolve(context.directory) !== path.resolve(snapshot.directory)
    || !parent?.parts.some((item) => item.type === "text" && item.text && !item.synthetic && !item.ignored)
    || message?.parentId !== entry.messageId || message.completedAt != null || message.error
    || part?.tool !== name || part.toolStatus !== "running" || !isDeepStrictEqual(part.toolInput, args)) {
    throw new Error("Computer control requires this exact running tool call in a private user-request execution.");
  }
}

export function trustedComputerSender(event, contents, expectedUrl) {
  if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) return false;
  try {
    const actual = new URL(event.senderFrame.url);
    const expected = new URL(expectedUrl);
    actual.hash = ""; expected.hash = "";
    return ["file:", "http:", "https:"].includes(expected.protocol)
      && actual.origin === expected.origin && actual.href === expected.href;
  } catch { return false; }
}

async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Computer cleanup or operation timed out.")), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Adapters are trusted main-process dependencies, never renderer/model input.
 * connect() owns a dedicated session scope. close() MUST confirm session
 * revocation, not merely disconnect HTTP/MCP; reject when revocation is uncertain.
 * Failed connect must confirm it left no session, or throw AggregateError when
 * setup AND revocation failed without a usable handle. No remote provisioning.
 * Deliberately conservative: one controller across all targets, not one per OS. */
export function createComputerControl({ adapters, adapter, discussionFor, resolveContext, onRevoke = () => {}, cleanupMs = 3000, operationMs = 120_000, pollMs = 750, now = Date.now }) {
  if (adapters && adapter) throw new Error("Provide adapters or adapter, not both.");
  const configured = adapters ?? (adapter ? [adapter] : []);
  if (!Array.isArray(configured) || !configured.length) throw new Error("At least one trusted computer adapter is required.");
  const targets = new Map();
  for (const candidate of configured) {
    if (!candidate || typeof candidate.id !== "string" || !candidate.id.trim() || targets.has(candidate.id)
      || typeof candidate.label !== "string" || !candidate.label.trim() || !["desktop", "cloud"].includes(candidate.placement)
      || candidate.protocol !== COMPUTER_PROTOCOL || ["readiness", "setup", "connect"].some((name) => typeof candidate[name] !== "function")) {
      throw new Error("Computer adapters require unique IDs, labels, placement, the supported protocol, and readiness/setup/connect.");
    }
    targets.set(candidate.id, Object.freeze({ ...candidate }));
  }
  if (!configured.some((item) => item.placement === "cloud")) {
    if (targets.has(remote.id)) throw new Error("The remote placeholder ID is reserved for a cloud computer.");
    targets.set(remote.id, remote);
  }
  const defaultTarget = targets.get(configured[0].id);
  for (const value of [cleanupMs, operationMs, pollMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("Computer time limits must be positive bounded milliseconds.");
  const grants = new Map();
  const calls = new Map();
  const cancelledCalls = new Set();
  let lease = null;
  let tail = Promise.resolve();
  let closed = false;
  let resetting = 0;
  let epoch = 0;
  function disable(grant) {
    grant.enabled = false; grant.revision++;
    onRevoke({ slug: grant.slug, threadId: grant.threadId, surface: "computer" });
  }
  const serial = (work) => {
    const result = tail.then(work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  async function grantFor(slug, threadId) {
    if (closed || resetting) throw new Error("Computer control is stopping.");
    if (typeof slug !== "string" || !slug || typeof threadId !== "string" || !threadId) throw new Error("A coworker and saved discussion are required.");
    const started = epoch;
    let scope;
    try { scope = await discussionFor(slug, threadId); }
    catch (error) { await api.revoke({ slug, threadId }); throw error; }
    if (closed || resetting || epoch !== started) throw new Error("Computer control is stopping or restarted.");
    const key = keyFor(slug, threadId);
    let grant = grants.get(key);
    if (grant && (grant.workspaceId !== scope.workspaceId || grant.directory !== scope.directory)) {
      disable(grant);
      if (lease?.grant === grant) await cleanup(lease);
      throw new Error("This discussion's original workspace changed. Computer control was revoked.");
    }
    if (!grant) {
      grant = { slug, threadId, ...scope, revision: 0, targetId: defaultTarget.id, adapter: defaultTarget, enabled: false };
      grants.set(key, grant);
    }
    return grant;
  }
  async function readiness(target) {
    try {
      const status = await bounded(target.readiness(), cleanupMs);
      if (!["ready", "setup-required", "unsupported", "unavailable"].includes(status?.readiness) || typeof status.detail !== "string") throw new Error("Invalid readiness.");
      const permissions = status.permissions;
      if (permissions !== undefined && (typeof permissions?.accessibility !== "boolean" || typeof permissions?.screenRecording !== "boolean")) throw new Error("Invalid permissions.");
      return { readiness: status.readiness, detail: status.detail,
        ...(permissions ? { permissions: { accessibility: permissions.accessibility, screenRecording: permissions.screenRecording } } : {}) };
    } catch { return { readiness: "unavailable", detail: "The selected computer's service is unavailable." }; }
  }
  function revise(grant, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== grant.revision) throw new Error("Computer settings changed. Refresh this discussion before trying again.");
    return ++grant.revision;
  }
  function updateSession(current, result, purpose) {
    const state = stateOf(result);
    if (!state) return;
    const paused = state.state === "paused" || state.next === "human_takeover";
    if (paused && current.sessionId) current.needsObservation = true;
    if ((result.isError || state.ok !== true) && !paused) return;
    const opening = current.session?.state === "opening";
    current.session = {
      ...current.session,
      state: paused ? "paused" : state.state ?? current.session?.state ?? "active",
      purpose: purpose ?? state.purpose ?? current.session?.purpose ?? "",
      ...(typeof state.app_name === "string" ? { appName: state.app_name } : {}),
      ...(typeof state.window_title === "string" ? { windowTitle: state.window_title } : {}),
      ...(typeof state.phase === "string" ? { phase: state.phase } : paused ? { phase: "waiting-for-person" } : {}),
      ...(Number.isFinite(state.expires_in_seconds) ? { expiresAt: new Date(now() + state.expires_in_seconds * 1000).toISOString() } : {}),
      reason: typeof state.pause_reason === "string" ? state.pause_reason : paused ? state.message ?? "Continue or Stop in the native computer controls." : "",
    };
    if (!paused && (opening || state.state === "active") && typeof state.phase !== "string") delete current.session.phase;
  }
  function nativeStopped(current, result) {
    if (stateOf(result)?.code !== "session_unavailable") return false;
    disable(current.grant);
    current.nativeStopped = true;
    return true;
  }
  async function cleanup(current) {
    current.closing = true;
    current.controller.abort(new Error("Computer control stopped."));
    current.cleanupPending = true;
    if (!current.cleanup) {
      current.cleanup = (async () => {
        // Do not free the machine while an open/connect may still acknowledge late.
        await current.work?.catch(() => {});
        if (current.connectionUncertain && !current.transport) throw new Error("Connection setup failed without a confirmed helper shutdown.");
        if (current.transport && !current.transportClosed) {
          if (current.sessionId) {
            try { nativeStopped(current, await bounded(current.transport.callTool("computer_close_session", { session_id: current.sessionId }), cleanupMs)); }
            catch { /* close() below must still confirm session revocation. */ }
          }
          // A remote HTTP disconnect is NOT sufficient for this receipt.
          await bounded(current.transport.close(), cleanupMs);
          current.transportClosed = true;
        }
        current.cleanupPending = false;
        if (lease === current) lease = null;
        return true;
      })().catch(() => false).finally(() => { current.cleanup = null; });
    }
    try { return await bounded(current.cleanup, cleanupMs); }
    catch {
      // Closing the dedicated transport also cancels a native approval sheet.
      // Keep the reservation until the in-flight operation actually settles.
      if (current.transport && !current.transportClosed) {
        try { await bounded(current.transport.close(), cleanupMs); current.transportClosed = true; } catch { /* Still uncertain; Stop can retry cleanup. */ }
      }
      return !current.cleanupPending;
    }
  }
  async function view(grant, poll = false) {
    if (poll && lease?.grant === grant && lease.sessionId && !lease.closing && !lease.busy) {
      await serial(async () => {
        const current = lease;
        if (current?.grant !== grant || current.closing || !current.sessionId) return;
        current.work = current.transport.callTool("computer_session_status", { session_id: current.sessionId }, { signal: current.controller.signal });
        try {
          const result = await bounded(current.work, cleanupMs);
          if (nativeStopped(current, result)) {
            await cleanup(current);
          } else if (result.isError || stateOf(result)?.ok !== true) {
            current.session = { ...current.session, state: "unavailable", reason: stateOf(result)?.message ?? "Native status is unavailable." };
          } else updateSession(current, result);
        } catch {
          disable(grant);
          await cleanup(current);
        }
      });
    }
    const statuses = await Promise.all([...targets.values()].map(async (target) => ({ target, ...await readiness(target) })));
    const other = lease && lease.grant !== grant;
    const busyReason = lease?.closing ? "Native release has not yet been confirmed." : other ? "Another discussion is using this computer." : "";
    const selected = statuses.find((status) => status.target === grant.adapter);
    const current = lease?.grant === grant ? lease : null;
    return {
      revision: grant.revision, targetId: grant.targetId,
      targets: statuses.map(({ target, readiness, detail }) => ({ id: target.id, label: target.label, placement: target.placement, available: readiness === "ready" && !busyReason,
        ...(readiness !== "ready" ? { reason: detail } : busyReason ? { reason: busyReason } : {}) })),
      enabled: grant.enabled, readiness: selected.readiness,
      ...(selected.permissions ? { permissions: selected.permissions } : {}),
      detail: current?.cleanupPending ? "Stopping computer control. Native release has not yet been confirmed." : selected.detail,
      session: current?.session ? { ...current.session, ...(current.closing ? { state: "stopping" } : {}) } : null,
      ...(current?.cleanupPending ? { cleanupPending: true } : {}),
    };
  }
  const api = {
    async delegationScope({ slug, threadId }) {
      const grant = await grantFor(slug, threadId);
      if (lease || !grant.enabled) throw new Error("Allow computer access in the original discussion and finish its current native session before approving this Worker.");
      const revision = grant.revision;
      const assertActive = () => {
        if (closed || resetting || !grant.enabled || grant.revision !== revision) throw new Error("The originating discussion's computer permission or target changed.");
      };
      const status = await readiness(grant.adapter);
      assertActive();
      if (status.readiness !== "ready") throw new Error(status.detail);
      return { targetId: grant.targetId, revision, assertActive };
    },
    async snapshot({ slug, threadId }) { return view(await grantFor(slug, threadId), true); },
    async configure({ slug, threadId, expectedRevision, enabled, targetId }) {
      if (typeof enabled !== "boolean" || !targets.has(targetId)) throw new Error("Choose a known computer and an explicit enable setting.");
      const grant = await grantFor(slug, threadId);
      const revision = revise(grant, expectedRevision);
      grant.enabled = false;
      onRevoke({ slug, threadId, surface: "computer" });
      if (lease?.grant === grant) await cleanup(lease);
      if (grant.revision !== revision || closed || resetting) throw new Error("Computer configuration was stopped before it finished.");
      if (lease?.grant === grant) return view(grant);
      grant.targetId = targetId;
      grant.adapter = targets.get(targetId);
      if (enabled) {
        const ready = await readiness(grant.adapter);
        if (grant.revision !== revision || closed || resetting) throw new Error("Computer configuration was stopped before it finished.");
        if (lease && lease.grant !== grant) throw new Error("Another discussion is using this computer. Stop it there first.");
        grant.enabled = ready.readiness === "ready";
      }
      return view(grant);
    },
    async stop({ slug, threadId, expectedRevision }) {
      // An already validated grant can always be revoked, even if its saved
      // discussion disappeared or the engine is currently unresponsive.
      const grant = grants.get(keyFor(slug, threadId)) ?? await grantFor(slug, threadId);
      revise(grant, expectedRevision);
      grant.enabled = false;
      onRevoke({ slug, threadId, surface: "computer" });
      if (lease?.grant === grant) await cleanup(lease);
      return view(grant);
    },
    async setup({ targetId = defaultTarget.id, permission } = {}) {
      if (closed || resetting || lease) throw new Error("Stop computer control before opening native permission setup.");
      if (!["accessibility", "screenRecording"].includes(permission)) throw new Error("Choose Accessibility or Screen Recording settings.");
      const target = targets.get(targetId);
      if (!target) throw new Error("Choose a known computer.");
      await target.setup(permission);
    },
    async execute(slug, { name, args, context, cancel = false }) {
      if (!Object.hasOwn(COMPUTER_TOOLS, name) || !context?.sessionID || !context.messageID || !context.callID || !context.directory) throw new Error("A trusted native computer tool context is required.");
      const key = JSON.stringify([slug, context.directory, context.sessionID, context.messageID, context.callID]);
      if (cancel) {
        // A native abort may beat the original HTTP request's admission.
        // Remember that exact call so a delayed request cannot start afterwards.
        if (!calls.has(key)) await resolveContext(slug, context, { name, args });
        const call = calls.get(key);
        if (call && (!call.active || call.name !== name || !isDeepStrictEqual(call.args, args))) throw new Error("No matching admitted computer call can be cancelled.");
        if (cancelledCalls.size >= 4096) throw new Error("The computer cancellation limit was reached. Stop control in the native panel.");
        cancelledCalls.add(key);
        const grant = call?.grant ?? grants.get(keyFor(slug, context.sessionID));
        if (grant) disable(grant);
        if (lease && lease.grant === grant) await cleanup(lease);
        return failure("cancelled", "Computer control stopped.");
      }
      if (cancelledCalls.has(key)) throw new Error("This native computer call was cancelled before admission.");
      const trusted = await resolveContext(slug, context, { name, args });
      const originThreadId = trusted.origin?.threadId ?? context.sessionID;
      const grant = await grantFor(slug, originThreadId);
      if (path.resolve(context.directory) !== path.resolve(grant.directory)) throw new Error("This native call belongs to another workspace.");
      const revision = grant.revision;
      const selectedAdapter = grant.adapter;
      const check = () => {
        trusted.assertActive();
        if (closed || resetting || cancelledCalls.has(key) || !grant.enabled || grant.adapter !== selectedAdapter || grant.revision !== revision || trusted.entry.workspaceId !== grant.workspaceId) throw new Error("Computer control is disabled, revoked, or belongs to another workspace.");
      };
      check();
      const allowed = name === "coworker_computer_open" ? ["app_id", "pid", "mode", "purpose"] : name === "coworker_computer_observe" ? ["include_image"] : name === "coworker_computer_act" ? ["observation_id", "action"] : [];
      if (!args || Array.isArray(args) || typeof args !== "object" || Object.keys(args).some((key) => !allowed.includes(key))) throw new Error("Only native computer arguments are accepted; session and receipt identities belong to the broker.");
      const previous = calls.get(key);
      if (previous) {
        if (previous.name !== name || !isDeepStrictEqual(previous.args, args) || previous.grant !== grant) throw new Error("This native call identity was already used for different input.");
        if (previous.adapter !== selectedAdapter) throw new Error("This native call identity was already used for another computer.");
        return previous.result;
      }
      if (calls.size >= 4096) throw new Error("This app launch reached its computer receipt limit. Stop computer control and restart the app.");
      const call = { name, args: structuredClone(args), grant, adapter: selectedAdapter, active: true };
      calls.set(key, call);
      call.result = serial(async () => {
        check();
        const fresh = await resolveContext(slug, context, { name, args });
        fresh.assertActive(); check();
        await discussionFor(slug, originThreadId).then((scope) => { if (scope.workspaceId !== grant.workspaceId || scope.directory !== grant.directory) throw new Error("The original discussion workspace is unavailable."); });
        check();
        if (lease && (lease.grant !== grant || lease.adapter !== selectedAdapter || lease.closing || lease.executionId !== trusted.entry.id)) throw new Error("Another discussion or an earlier turn still owns this computer.");
        lease ??= { grant, adapter: selectedAdapter, executionId: trusted.entry.id, messageId: trusted.entry.messageId, controller: new AbortController(), sessionId: null, session: null, busy: false };
        const current = lease;
        current.busy = true;
        const abort = () => { disable(grant); void cleanup(current); };
        trusted.signal.addEventListener("abort", abort, { once: true });
        const signal = AbortSignal.any([trusted.signal, current.controller.signal, AbortSignal.timeout(operationMs)]);
        let nativeResult;
        let handoff = false;
        current.work = Promise.resolve().then(async () => {
          if (!current.transport) {
            try { current.transport = await current.adapter.connect(); }
            catch (error) {
              // The adapter combines setup and shutdown errors when it could
              // not confirm termination and cannot return a usable handle.
              current.connectionUncertain = error instanceof AggregateError;
              throw error;
            }
            signal.throwIfAborted(); check();
          }
          const latest = await resolveContext(slug, context, { name, args });
          latest.assertActive();
          if (latest.entry.id !== trusted.entry.id) throw new Error("This tool no longer belongs to the admitted execution.");
          signal.throwIfAborted(); check();
          if (name === "coworker_computer_open" && current.sessionId) throw new Error("Close the approved session before requesting another app or mode.");
          if (!["coworker_computer_discover", "coworker_computer_open"].includes(name) && !current.sessionId) throw new Error("Open an approved app session first.");
          if (name === "coworker_computer_open") current.session = { state: "opening", purpose: args.purpose, phase: "native-approval" };
          const nativeArgs = { ...args, ...(current.sessionId && name !== "coworker_computer_discover" ? { session_id: current.sessionId } : {}),
            ...(name === "coworker_computer_act" ? { request_id: createHash("sha256").update(key).digest("hex") } : {}) };
          const result = name === "coworker_computer_act" && current.needsObservation
            ? failure("observation_required", "Native control paused or continued. Make a fresh observation before any action; no action was dispatched.", current.session?.state === "paused" ? { state: "paused", next: "human_takeover" } : {})
            : (nativeResult = await current.transport.callTool(COMPUTER_TOOLS[name], nativeArgs, { signal }));
          const state = stateOf(result);
          if (name === "coworker_computer_open" && typeof state?.session_id === "string") current.sessionId = state.session_id;
          if (!state || typeof state.ok !== "boolean") throw new Error("The native computer response was unreadable; its outcome is uncertain.");
          if (name === "coworker_computer_open" && state.ok && !current.sessionId) throw new Error("The native approval returned no session identity.");
          if (nativeStopped(current, result)) return result;
          if (name !== "coworker_computer_discover") updateSession(current, result, name === "coworker_computer_open" ? args.purpose : undefined);
          if (!current.sessionId || name === "coworker_computer_close" || (!needsPerson(result) && current.session?.state !== "paused")) {
            if (name === "coworker_computer_observe" && !result.isError && state.ok && typeof state.observation_id === "string") current.needsObservation = false;
            return result;
          }
          // Keep the original native tool active while the person decides.
          // Only status reads follow Continue: never resume or redispatch input.
          handoff = true;
          let status = result;
          do {
            current.needsObservation = true;
            updateSession(current, status);
            await delay(pollMs, undefined, { signal });
            const owner = await resolveContext(slug, context, { name, args });
            owner.assertActive(); check(); signal.throwIfAborted();
            if (owner.entry.id !== current.executionId) throw new Error("The computer handoff's owning execution changed.");
            status = await current.transport.callTool("computer_session_status", { session_id: current.sessionId }, { signal });
            if (nativeStopped(current, status)) break;
            updateSession(current, status);
          } while (needsPerson(status));
          const continued = stateOf(status);
          current.handoffFailed = status.isError === true || continued?.ok !== true;
          if (!current.handoffFailed && continued.state !== "active") throw new Error("The native handoff did not confirm active control.");
          if (name === "coworker_computer_act" || result.isError) return withHandoff(result, status);
          if (current.handoffFailed) return status;
          if (name === "coworker_computer_observe") return withHandoff(failure("observation_required", "The previous observation predates the handoff. Observe again."), status);
          return { ...status, content: [{ type: "text", text: JSON.stringify({ ...state, ...continued, next: "observe", fresh_observation_required: true }) }] };
        });
        try {
          const result = await bounded(current.work, operationMs);
          if (name === "coworker_computer_close" || current.nativeStopped || current.handoffFailed || (name === "coworker_computer_open" && result.isError)) {
            if (name !== "coworker_computer_close") disable(grant);
            if (stateOf(result)?.ok === true && name === "coworker_computer_close") current.sessionId = null;
            await cleanup(current);
          }
          if (result.isError) return result;
          // Preserve a dispatched or uncertain native receipt even when Stop raced it.
          if (current.closing && name !== "coworker_computer_act" && name !== "coworker_computer_close") return failure("revoked", "Computer control stopped before this result could be delivered.");
          return result;
        } catch (error) {
          disable(grant);
          await cleanup(current);
          const interrupted = failure(handoff ? "handoff_interrupted" : name === "coworker_computer_act" ? "dispatch_uncertain" : "operation_interrupted", `${error.message} Do not replay this call; inspect the native computer controls before continuing.`);
          return nativeResult && (name === "coworker_computer_act" || nativeResult.isError) ? withHandoff(nativeResult, interrupted) : interrupted;
        } finally {
          current.busy = false;
          trusted.signal.removeEventListener("abort", abort);
        }
      }).then((result) => {
        call.active = false;
        // Only action receipts need replayable results. Do not retain captured
        // images in this launch's deduplication table after delivery.
        if (name !== "coworker_computer_act") call.result = Promise.resolve(failure("already_completed", "This native call already completed. Use a new tool call for a new observation; do not replay actions."));
        return result;
      }, (error) => { call.active = false; throw error; });
      return call.result;
    },
    async endTurn(entry) {
      // Handoffs wait inside their tool, never by borrowing the next turn.
      // An idle lease is revoked here; a later turn needs new native approval.
      if (lease?.executionId !== entry.id) return;
      if (entry.state === "cancelled" && lease.grant.enabled) disable(lease.grant);
      if (!await cleanup(lease)) throw new Error(COMPUTER_STOP_GUIDANCE);
    },
    async revoke({ slug, threadId } = {}) {
      for (const grant of grants.values()) if ((!slug || grant.slug === slug) && (!threadId || grant.threadId === threadId)) disable(grant);
      if (lease && (!slug || lease.grant.slug === slug) && (!threadId || lease.grant.threadId === threadId)) return cleanup(lease);
      return true;
    },
    async reset(shutdown = false, during = async () => {}) {
      epoch++;
      resetting++;
      if (shutdown) closed = true;
      try {
        const confirmed = await api.revoke();
        if (!confirmed) return { confirmed: false };
        return { confirmed: true, value: await during() };
      } finally { resetting--; }
    },
  };
  return api;
}
