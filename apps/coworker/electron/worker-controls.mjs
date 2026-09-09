import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BROWSER_TOOLS } from "./browser-control.mjs";
import { COMPUTER_TOOLS } from "./computer-control.mjs";

export const WORKER_MANAGEMENT = ["worker_steer", "worker_pause", "worker_resume", "worker_cancel"];
const terminal = new Set(["finished", "failed", "cancelled"]);
const keyFor = (slug, id) => `${slug}:${id}`;
async function bounded(work, ms) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Worker control cleanup timed out.")), ms); })]); }
  finally { clearTimeout(timer); }
}

export function workerControlRequest(surface) {
  if (surface === undefined) return undefined;
  if (!["browser", "computer"].includes(surface)) throw new Error("Choose browser or computer control.");
  return { surface, state: "needs-approval", revision: 0, detail: "Waiting for your approval of this Worker and goal in its original discussion." };
}

/** A native call's actual tool part is authority, not a model-supplied origin. */
export function assertWorkerToolContext({ slug, context, name, args, entry, snapshot, workspaceId, active }) {
  const message = snapshot.messages.find((item) => item.id === context.messageID && item.role === "assistant");
  const part = message?.parts.find((item) => item.type === "tool" && item.callId === context.callID);
  if (!active || entry?.state !== "running" || !entry.sentAt || entry.owner.slug !== slug
    || entry.owner.threadId !== context.sessionID || snapshot.threadId !== context.sessionID
    || !workspaceId || workspaceId !== entry.workspaceId || !context.directory || !snapshot.directory
    || path.resolve(context.directory) !== path.resolve(snapshot.directory)
    || !snapshot.messages.some((item) => item.id === entry.messageId && item.role === "user")
    || message?.parentId !== entry.messageId || message.completedAt != null || message.error
    || part?.tool !== name || part.toolStatus !== "running" || !isDeepStrictEqual(part.toolInput, args)) {
    throw new Error("This Worker operation requires its exact running native tool, message, workspace and input.");
  }
}

export function assertControlOrigin(entry) {
  if (entry.owner.kind !== "private" || entry.owner.threadId !== entry.owner.conversationId || !entry.personRequest || entry.continuation) {
    throw new Error("Worker control requires an explicit person request in its saved private originating discussion. Groups, assignments and automatic follow-ups cannot grant it.");
  }
}

export function assertWorkerSupervisor(entry, worker) {
  if (!worker.control) return;
  if (!entry) throw new Error("Control Worker management requires the context-bound native tool in its original discussion.");
  assertControlOrigin(entry);
  if (worker.slug !== entry.owner.slug || worker.spawnedFromThreadId !== entry.owner.threadId) throw new Error("Manage this control Worker only from its originating discussion.");
}

/** Requests survive restart; none of the controller authority in this map does. */
export function createWorkerControls({ discussionFor, taskFor, readWorker, updateWorker, liveRuns, browser, computer, stopNative, now = Date.now, approvalMs = 15 * 60_000, cleanupMs = 4000 }) {
  const records = new Map();
  let closed = false;
  function record(worker) {
    if (!worker.control) return null;
    const key = keyFor(worker.slug, worker.id);
    if (!records.has(key)) records.set(key, {
      key, slug: worker.slug, id: worker.id, threadId: worker.spawnedFromThreadId,
      surface: worker.control.surface, revision: Math.max(now(), worker.control.revision + 1),
      state: worker.control.state === "revoked" ? "revoked" : "needs-approval",
      detail: "Approve this Worker and goal in its original discussion. Earlier approvals do not survive restart.",
      reserved: false, pending: null, timer: null, run: null, cleaned: true, cleanup: null,
    });
    return records.get(key);
  }
  function assertGrant(current) {
    if (closed || current.state !== "approved" || now() >= current.expiresAt) throw new Error("Worker control needs a new approval; it is stopped, revoked or expired.");
    current.task.assertActive();
    current.computer?.assertActive();
  }
  function summary(worker) {
    const current = record(worker);
    if (!current) return worker;
    if (current.state === "approved") {
      try { assertGrant(current); } catch { void invalidate(current, "Control approval ended. Approve again before continuing."); }
    }
    return { ...worker, control: { surface: current.surface, state: current.state, revision: current.revision, detail: current.detail } };
  }
  function expectRevision(current, revision) {
    if (!current || !Number.isSafeInteger(revision) || revision !== current.revision) throw new Error("Worker control changed. Refresh before approving or revoking it.");
  }
  async function drain(current) {
    if (current.cleaned) return true;
    if (!current.cleanup) current.cleanup = (async () => {
      const results = await Promise.allSettled([
        bounded(current.surface === "browser" ? browser.revokeOrigin({ slug: current.slug, threadId: current.threadId, cleanupMs }) : Promise.resolve(true), cleanupMs + 100),
        bounded(current.run ? computer.endTurn({ ...current.run.entry, state: current.state === "revoked" ? "cancelled" : current.run.entry.state }) : Promise.resolve(), cleanupMs + 100),
      ]);
      current.cleaned = results.every((result) => result.status === "fulfilled" && result.value !== false);
      return current.cleaned;
    })().finally(() => { current.cleanup = null; });
    return current.cleanup;
  }
  function invalidate(current, detail) {
    if (current.pending) return current.pending;
    current.state = "revoked";
    current.revision++;
    current.detail = detail;
    current.reserved = true;
    clearTimeout(current.timer);
    // Install the pending receipt before abort listeners can re-enter revocation.
    current.pending = Promise.resolve().then(async () => {
      const [cleanup, native] = await Promise.all([drain(current), current.run?.client && current.run.entry.owner.threadId
        ? bounded(stopNative(current.run.client, current.run.entry.owner.threadId, AbortSignal.timeout(cleanupMs)), cleanupMs).then(() => true, () => false) : true]);
      if (!native) current.cleaned = false;
      current.detail = cleanup && native ? "Control revoked. A new approval is required to continue." : "Control revoked; input cleanup is unconfirmed. Stop again to check release. No successor can use this scope.";
      await updateWorker(current.slug, current.id, (worker) => ({
        ...(!terminal.has(worker.status) ? { status: "paused", waitingFor: "" } : {}),
        control: { surface: current.surface, state: "revoked", revision: current.revision, detail: current.detail },
      })).catch(() => { current.detail += " The Worker record could not be updated; control is still revoked."; });
      return cleanup && native;
    }).catch(() => { current.reserved = true; current.detail = "Control revoked; cleanup could not be confirmed. Stop again before continuing."; return false; })
      .finally(() => { current.pending = null; current.reserved = !current.cleaned || liveRuns.get(current.key) === current.run && Boolean(current.run); });
    current.run?.controller.abort(new Error(detail));
    return current.pending;
  }
  const api = {
    summary,
    allowed(worker) {
      const current = record(worker);
      if (!current) return true;
      try { assertGrant(current); return true; } catch { return false; }
    },
    assertAvailable(slug, threadId) {
      if ([...records.values()].some((item) => item.slug === slug && item.threadId === threadId && (item.reserved || item.pending || item.state === "approved"))) {
        throw new Error("An approved Worker owns this discussion's control. Steer it or revoke its control before using the same surface.");
      }
    },
    async approve(worker, expectedRevision) {
      const current = record(worker);
      expectRevision(current, expectedRevision);
      if (closed || terminal.has(worker.status) || !current.threadId) throw new Error("This Worker cannot receive control.");
      if (current.state === "approved" || current.reserved || current.pending || liveRuns.has(current.key)) throw new Error("Earlier control is still active or stopping. Revoke and confirm release first.");
      api.assertAvailable(current.slug, current.threadId, current.surface);
      current.reserved = true;
      current.cleaned = false;
      const revision = ++current.revision;
      const check = () => { if (closed || current.revision !== revision || current.state === "revoked" && current.pending) throw new Error("Approval was revoked before it finished."); };
      try {
        const scope = await bounded(discussionFor(current.slug, current.threadId), 8000); check();
        const task = await bounded(taskFor(worker), 8000); task.assertActive(); check();
        const latest = await readWorker(worker.slug, worker.id); check();
        if (terminal.has(latest.status) || latest.goal !== worker.goal || latest.name !== worker.name || latest.spawnedFromThreadId !== current.threadId) throw new Error("The Worker or its goal changed. Review it again.");
        const computerScope = current.surface === "computer" ? await computer.delegationScope({ slug: current.slug, threadId: current.threadId }) : null;
        check();
        if (current.surface === "browser" && !await browser.revokeOrigin({ slug: current.slug, threadId: current.threadId, cleanupMs })) throw new Error("Earlier browser input has not stopped. Revoke and confirm release first.");
        check(); task.assertActive(); computerScope?.assertActive();
        current.cleaned = true;
        current.scope = scope; current.task = task; current.computer = computerScope;
        current.goal = worker.goal; current.name = worker.name;
        current.expiresAt = Math.min(now() + approvalMs, worker.lifespan.kind === "until" ? worker.lifespan.at : Infinity);
        if (current.expiresAt <= now()) throw new Error("This Worker's lifespan has ended.");
        current.state = "approved";
        current.detail = "Approved for this Worker and goal for up to 15 minutes. Takeover and consequential actions still require the person.";
        current.timer = setTimeout(() => { void invalidate(current, "Worker control approval expired."); }, current.expiresAt - now());
        current.timer.unref?.();
        const updated = await updateWorker(worker.slug, worker.id, (value) => {
          check(); assertGrant(current);
          if (terminal.has(value.status)) throw new Error("The Worker stopped before approval completed.");
          const steers = [...(value.pendingTurn?.steers ?? []), ...value.pendingSteers];
          return { status: "waiting", waitingFor: "turn", pendingTurn: null, pendingSteers: steers.filter((steer, index) => !steer.id || steers.findIndex((item) => item.id === steer.id) === index), control: { surface: current.surface, state: "needs-approval", revision: current.revision, detail: "Approval must be renewed after restart." } };
        });
        check();
        return summary(updated);
      } catch (error) {
        await invalidate(current, "Approval did not complete. Revoke and review before trying again.");
        throw error;
      }
    },
    revoke(worker, expectedRevision) {
      const current = record(worker);
      if (!current) return Promise.resolve(true);
      if (expectedRevision !== undefined) expectRevision(current, expectedRevision);
      return invalidate(current, "Worker control revoked. Stopping active input.");
    },
    revokeId(slug, id) {
      const current = records.get(keyFor(slug, id));
      return current ? invalidate(current, "Worker control stopped.") : Promise.resolve(true);
    },
    revokeKnown(slug, id, expectedRevision) {
      const current = records.get(keyFor(slug, id));
      if (!current) return null;
      expectRevision(current, expectedRevision);
      return invalidate(current, "Worker control revoked. Stopping active input.");
    },
    revokeOrigin({ slug, threadId, surface } = {}) {
      return Promise.all([...records.values()].filter((item) => (!slug || item.slug === slug) && (!threadId || item.threadId === threadId) && (!surface || item.surface === surface))
        .map((item) => invalidate(item, "The originating discussion revoked Worker control.")));
    },
    async reset(shutdown = false) {
      closed = true;
      try { return (await api.revokeOrigin()).every(Boolean); }
      finally { closed = shutdown; }
    },
    async admit(worker, run) {
      const current = record(worker);
      if (!current) return;
      assertGrant(current);
      const latest = await readWorker(worker.slug, worker.id);
      if (latest.goal !== current.goal || latest.name !== current.name || latest.control?.surface !== current.surface || latest.spawnedFromThreadId !== current.threadId || latest.status !== "running") throw new Error("The approved Worker changed or stopped.");
      const scope = await discussionFor(worker.slug, current.threadId);
      assertGrant(current);
      if (scope.workspaceId !== current.scope.workspaceId || scope.directory !== current.scope.directory || run.entry.workspaceId !== scope.workspaceId) throw new Error("The approved workspace changed.");
      current.run = run;
      current.cleaned = false;
      run.control = current;
    },
    async resolve(slug, context, expected, surface) {
      const run = [...liveRuns.values()].find((item) => item.entry?.owner.slug === slug && item.entry.owner.threadId === context.sessionID);
      if (!run) return null;
      const current = run.control;
      const assertActive = () => {
        if (!current || current.surface !== surface || current.run !== run || liveRuns.get(current.key) !== run || !run.active || run.controller.signal.aborted) throw new Error("This Worker has no active control delegation.");
        assertGrant(current);
      };
      assertActive();
      const tools = surface === "browser" ? BROWSER_TOOLS : COMPUTER_TOOLS;
      if (!Object.hasOwn(tools, expected.name)) throw new Error("This tool is outside the approved control surface.");
      const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(8000)]);
      const [snapshot, scope, worker] = await bounded(Promise.all([
        run.client.getThreadSnapshot(context.sessionID, { signal }), discussionFor(slug, current.threadId), readWorker(slug, current.id),
      ]), 8000).catch((error) => { void invalidate(current, "The original Worker scope could not be verified."); throw error; });
      assertActive();
      if (worker.status !== "running" || worker.control?.surface !== current.surface || worker.threadId !== context.sessionID || worker.name !== current.name || worker.goal !== current.goal || worker.spawnedFromThreadId !== current.threadId
        || scope.workspaceId !== current.scope.workspaceId || scope.directory !== current.scope.directory) throw new Error("The approved Worker origin or scope changed.");
      assertWorkerToolContext({ slug, context, ...expected, entry: run.entry, snapshot, workspaceId: scope.workspaceId, active: true });
      return { entry: run.entry, origin: { threadId: current.threadId }, signal: run.controller.signal, assertActive };
    },
    async endRun(run) {
      if (!run.control) return true;
      run.active = false;
      const current = run.control;
      if (current.run !== run) return true;
      if (!await drain(current)) { await invalidate(current, "Worker input cleanup is unconfirmed."); return false; }
      return true;
    },
    releaseRun(run) {
      const current = run.control;
      if (current?.run === run && current.state !== "approved" && current.cleaned && !current.pending && !run.cleanupError) current.reserved = false;
    },
  };
  return api;
}
