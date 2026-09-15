import { PROGRESS_AGENT, PROGRESS_LIMITS, PROGRESS_TITLE } from "../src/lib/progress-config.ts";
import { createProgressBudget, createProgressService, progressFingerprint } from "../src/lib/progress-service.ts";
import { executionProgress } from "../src/lib/progress-activity.ts";
import { setTimeout as delay } from "node:timers/promises";

/** Fresh native session, explicit agent/model, no structured-output tool or history. */
export async function summarizeProgress(client, model, { prompt, signal }) {
  signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(PROGRESS_LIMITS.timeoutMs)]);
  let thread;
  const stop = () => {
    return thread ? client.abortThread(thread.id, { signal: AbortSignal.timeout(PROGRESS_LIMITS.cleanupMs) }).catch(() => {}) : Promise.resolve();
  };
  signal.throwIfAborted();
  signal.addEventListener("abort", stop);
  try {
    // Do not abandon admission's receipt when the observer cancels: if native
    // accepts after the first abort, the finally block aborts that session again.
    thread = await client.createThread({ title: PROGRESS_TITLE, agent: PROGRESS_AGENT, model, signal: AbortSignal.timeout(PROGRESS_LIMITS.timeoutMs) });
    signal.throwIfAborted();
    const acceptance = await client.sendTurn(thread.id, { prompt, agent: PROGRESS_AGENT, model, signal: AbortSignal.timeout(PROGRESS_LIMITS.timeoutMs) });
    signal.throwIfAborted();
    for (;;) {
      const snapshot = await client.getThreadSnapshot(thread.id, { signal });
      signal.throwIfAborted();
      if (snapshot.native?.engine !== "v2" || snapshot.status.type === "retry" || acceptance.retried || acceptance.alreadyPresent) throw new Error("Progress selection refused.");
      const outcome = snapshot.native.turnOutcomes?.[acceptance.messageId];
      if (outcome === "failed" || outcome === "interrupted") throw new Error("Progress selection refused.");
      const replies = snapshot.messages.filter((message) => message.role === "assistant");
      if (snapshot.native.ambiguousTurns?.includes(acceptance.messageId) || replies.length > 1
        || replies.some((message) => message.parentId != null && message.parentId !== acceptance.messageId)) throw new Error("Progress selection refused.");
      const reply = replies[0];
      if (reply?.error || reply?.usage?.reasoningTokens > 0 || reply?.usage?.outputTokens > PROGRESS_LIMITS.maxOutputTokens) throw new Error("Progress selection refused.");
      let text = "";
      if (reply) {
        if (reply.parts.length > PROGRESS_LIMITS.maxReplyParts) throw new Error("Progress selection refused.");
        for (const part of reply.parts) {
          if (part.type === "step-start" || part.type === "step-finish") continue;
          if (part.type !== "text" || typeof part.text !== "string" || part.synthetic || part.ignored) throw new Error("Progress selection refused.");
          text += part.text;
          if (Buffer.byteLength(text) > PROGRESS_LIMITS.maxOutputTokens * 16) throw new Error("Progress selection refused.");
        }
      }
      if (reply?.completedAt != null && reply.parentId === acceptance.messageId && outcome === "succeeded") {
        return text;
      }
      await delay(PROGRESS_LIMITS.summaryPollMs, undefined, { signal });
    }
  } finally {
    signal.removeEventListener("abort", stop);
    await stop();
  }
}

/** Background observer only. Nothing here admits, resumes, or changes parent work. */
export function createProgressSummaries({ listExecutions, readActivity, ready, settings, startedAt = Date.now() }) {
  const budgets = new Map();
  const active = new Map();
  let config = { progressSummariesEnabled: false, progressSummaryModelId: "" };
  let revision = 0;
  let timer;
  let closed = false;
  let ticking = false;
  const clear = () => { for (const entry of active.values()) entry.service.dispose(); active.clear(); };
  const configure = (next) => {
    if (config.progressSummariesEnabled === next.progressSummariesEnabled && config.progressSummaryModelId === next.progressSummaryModelId) return;
    config = next;
    revision++;
    clear();
  };
  const observationOf = (activity) => executionProgress(activity, activity.replies.some((reply) => reply.parts.some((part) => part.text.trim())));
  async function tick() {
    if (closed || ticking) return;
    ticking = true;
    const beforeSettings = revision;
    try {
      const next = await settings();
      if (closed || beforeSettings !== revision) return;
      configure(next);
      if (!config.progressSummariesEnabled || !config.progressSummaryModelId) return;
      const version = revision;
      const [executions, transport] = await Promise.all([listExecutions(), ready()]);
      if (closed || version !== revision) return;
      const model = transport?.models.find((item) => item.id === config.progressSummaryModelId);
      if (!model) { clear(); return; }
      const modelKey = JSON.stringify([transport.key, model]);
      for (const [id, entry] of active) {
        if (!executions.some((item) => item.executionId === id) || entry.modelKey !== modelKey) { entry.service.dispose(); active.delete(id); }
      }
      await Promise.all(executions.slice(0, PROGRESS_LIMITS.maxActivityExecutions).map(async (execution) => {
        // Recovered work never acquires a fresh budget, including continuations
        // whose original task predates this process.
        if (!(execution.createdAt > startedAt)) return;
        const budget = budgets.get(execution.budgetId) ?? createProgressBudget();
        budgets.set(execution.budgetId, budget);
        if (budget.calls >= PROGRESS_LIMITS.maxCallsPerExecution && !budget.pending) return;
        const activity = await readActivity(execution);
        if (closed || version !== revision || !activity) return;
        let entry = active.get(execution.executionId);
        if (!entry) {
          entry = { modelKey, note: undefined, observation: observationOf(activity), service: null };
          const owned = entry;
          entry.service = createProgressService({
            executionId: execution.executionId, enabled: true, cheapModelId: model.id, budget,
            summarize: async (request) => {
              const fingerprint = progressFingerprint(owned.observation);
              const [current, selected] = await Promise.all([listExecutions(), ready()]);
              request.signal.throwIfAborted();
              if (!current.some((item) => item.executionId === execution.executionId) || JSON.stringify([selected?.key, selected?.models.find((item) => item.id === model.id)]) !== modelKey) throw new Error("Progress selection stopped.");
              const text = await summarizeProgress(selected.client, { providerId: model.providerId, modelId: model.modelId }, request);
              const remaining = await listExecutions();
              const latest = remaining.some((item) => item.executionId === execution.executionId) ? await readActivity(execution) : null;
              const final = await listExecutions();
              request.signal.throwIfAborted();
              if (!final.some((item) => item.executionId === execution.executionId) || !latest || progressFingerprint(observationOf(latest)) !== fingerprint) throw new Error("Progress selection stopped.");
              return text;
            },
            onNote: (note) => { if (!closed && version === revision && active.get(execution.executionId) === owned) owned.note = note; },
          });
          active.set(execution.executionId, entry);
        }
        entry.observation = observationOf(activity);
        entry.note = entry.service.update(entry.observation);
      }));
    } catch { clear(); } finally { ticking = false; }
  }
  return {
    configure,
    tick,
    noteFor(activity) {
      const note = active.get(activity.executionId)?.note;
      return note?.fingerprint === progressFingerprint(observationOf(activity)) ? note : undefined;
    },
    start() {
      if (timer || closed) return;
      timer = setInterval(() => void tick(), PROGRESS_LIMITS.activityPollMs);
      timer.unref?.();
    },
    stop() { closed = true; revision++; clearInterval(timer); clear(); },
  };
}
