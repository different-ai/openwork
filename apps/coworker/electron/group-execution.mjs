import { createGroup, getGroup, listGroups, beginGroupTurn, updateGroup, updateGroupTurn, appendGroupEvent, readGroupTimeline, groupEventId, groupReplyEvent, EVENT_GROUP_AUTHORITY } from "./groups.mjs";
import { collaborationId, continuationPrompt, withAbort } from "./collaboration.mjs";
import { runGroupTurn, resumeGroupTurn, fallbackPlan, planSpeakers } from "../src/lib/groups.ts";
import { groupMessageKey } from "../src/lib/group-continuity.ts";
import { eventRunFor } from "./event-execution.mjs";
import { facilitatorPrompt, earlierSpeakerOrders, routeWithFacilitator, facilitatorModels } from "../src/lib/facilitator.ts";
import { DEFAULT_MODEL_DEFAULTS } from "../src/lib/model-defaults.ts";
import { effortForTurn } from "../src/lib/effort.ts";

/** The window only submits requests and reads projections. All group execution
 * and cancellation remain alive when that window navigates or reloads. */
export function createGroupExecution({ directory, collaboration, coworkerFor, coordinator, catalogFor, clientFor, settings = async () => ({ modelDefaults: DEFAULT_MODEL_DEFAULTS }), onPublished = async () => {}, eventContext = async () => { throw new Error("Event execution is unavailable."); }, conversationContext = async () => { throw new Error("Managed conversation context is unavailable."); }, setupTimeoutMs = 30_000, replyTimeoutMs = 180_000, pollMs = 750 }) {
  const active = new Map();
  let timer;
  let closed = false;
  let pumping = false;
  let failures = 0;
  let serviceError = "";
  const threadLocks = new Map();
  const pending = new Set();
  function track(work) {
    const task = Promise.resolve(work);
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  }
  async function publishReply(entry) {
    const event = await appendGroupEvent(directory, entry.owner.groupId, groupReplyEvent(entry));
    const group = await getGroup(directory, entry.owner.groupId);
    if (group.turns.some((turn) => turn.id === entry.owner.turnId)) {
      await updateGroupTurn(directory, group.id, entry.owner.turnId, { speaker: { slug: entry.owner.slug, part: entry.owner.part ?? "reply", status: event.status === "passed" ? "passed" : "succeeded", threadId: entry.owner.threadId, error: "", endedAt: entry.endedAt } });
    }
    // The receipt follows both writes; a crash before it retries the same event, never inference.
    await collaboration.change((state) => { state.executions[entry.id].groupReply.published = true; });
    if (event.status !== "passed") await onPublished(entry).catch(() => {});
    return event;
  }
  async function participant(groupId, slug, signal = AbortSignal.timeout(setupTimeoutMs)) {
    if (closed) throw new Error("Group collaboration is closing.");
    const key = `${groupId}:${slug}`;
    const previous = threadLocks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      signal.throwIfAborted();
      const group = await withAbort(getGroup(directory, groupId), signal);
      if (group.archivedAt !== null || !group.participantSlugs.includes(slug)) throw new Error("That coworker is no longer in this active group.");
      let threadId = group.participantThreadIds[slug];
      if (!threadId) {
        const client = await withAbort(track(clientFor(slug, { observationOnly: true, signal })), signal);
        signal.throwIfAborted();
        const thread = await withAbort(track(client.createThread({ title: `Group chat: ${group.name}`, signal })), signal);
        threadId = thread.id;
        await updateGroup(directory, groupId, { participantThreadIds: { [slug]: threadId } }, { authority: EVENT_GROUP_AUTHORITY });
      }
      const owner = { slug, threadId, conversationId: groupId, groupId, kind: "group" };
      signal.throwIfAborted();
      await withAbort(track(collaboration.registerOwner(owner)), signal);
      return owner;
    });
    threadLocks.set(key, run);
    // Aborting the observer does not complete an in-flight filesystem write.
    void run.finally(() => { if (threadLocks.get(key) === run) threadLocks.delete(key); }).catch(() => {});
    return withAbort(run, signal);
  }
  async function execute(groupId, request) {
    if (closed || serviceError || active.has(groupId)) return;
    const controller = new AbortController();
    active.set(groupId, { controller, requestId: request.id });
    const executions = new Set();
    let completedTurn;
    let failure = "";
    let deadlineTimer;
    try {
      const current = await collaboration.read((state) => state.groups[groupId]);
      if (closed || current?.cancelledRequestIds?.includes(request.id) || !current?.queue.some((entry) => entry.id === request.id)) return;
      const setupSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(setupTimeoutMs)]);
      let group = await withAbort(getGroup(directory, groupId), setupSignal);
      if (group.archivedAt !== null) throw new Error("The group is archived.");
      if (request.eventRunId) {
        const run = await collaboration.read((state) => eventRunFor(state, { eventRunId: request.eventRunId, groupId, slug: request.plan.speakers[0].slug }));
        deadlineTimer = setTimeout(() => controller.abort(new Error("The event reached its duration limit.")), Math.max(1, run.deadlineAt - Date.now()));
        deadlineTimer.unref?.();
        await withAbort(eventContext(request, request.plan.speakers[0].slug), setupSignal);
      } else if (group.eventId) {
        const context = await withAbort(conversationContext(groupId, request.conversationIdentity), setupSignal);
        request.conversationIdentity = context.identity;
      }
      const participants = await withAbort(Promise.all((request.participantSlugs ?? request.conversationIdentity?.participantSlugs ?? group.participantSlugs).map(coworkerFor)), setupSignal);
      const timeline = await withAbort(readGroupTimeline(directory, groupId), setupSignal);
      const deps = {
        begin: async (input) => {
          const begun = await beginGroupTurn(directory, groupId, input);
           await collaboration.change((state) => {
             const current = state.groups[groupId]?.queue.find((entry) => entry.id === request.id);
             if (current) current.turnId = begun.turn.id;
             if (request.eventRunId) state.workplaceEvents.runs[request.eventRunId].requests[request.eventPhase].turnId = begun.turn.id;
           });
          return begun;
        },
        record: (turnId, patch) => updateGroupTurn(directory, groupId, turnId, patch),
        append: async (event) => event.executionId
          ? publishReply(await collaboration.read((state) => state.executions[event.executionId]))
          : appendGroupEvent(directory, groupId, { ...event, id: groupEventId(event) }),
        ask: async (slug, prompt, signal, step) => {
          const conversation = request.conversationIdentity ? await conversationContext(groupId, request.conversationIdentity) : null;
          const context = request.eventRunId ? await eventContext(request, slug) : [conversation?.context, request.context].filter(Boolean).join("\n\n");
          const owner = { ...await participant(groupId, slug, AbortSignal.any([signal, AbortSignal.timeout(setupTimeoutMs)])), turnId: step.turnId, part: step.part,
            ...(request.eventRunId ? { eventRunId: request.eventRunId, eventPhase: request.eventPhase } : {}),
            ...(request.conversationIdentity ? { conversationIdentity: request.conversationIdentity } : {}) };
          if (signal.aborted) throw new Error("Stopped.");
          const baseId = collaborationId(groupId, step.turnId, slug, step.part, 0);
          const prior = await collaboration.read((state) => state.executions[baseId] ?? Object.values(state.executions).find((entry) => entry.owner.groupId === groupId && entry.owner.turnId === step.turnId && entry.owner.slug === slug && (entry.owner.part ?? "reply") === step.part));
          // A replayed backend request observes its original admission. A person's
          // explicit retry is a NEW follow-up in the same native history, never a deletion/replay.
          const id = request.attempt ? collaborationId(groupId, step.turnId, slug, step.part, "follow-up", request.id) : prior?.id ?? baseId;
          if (request.attempt && prior) {
            const task = await collaboration.read((state) => state.tasks[prior.taskId]);
            if (task?.dependencies.length) throw new Error("This reply already requested other work. Continue from its collaboration receipt instead of repeating those requests.");
            if (!["failed", "cancelled", "succeeded"].includes(prior.state)) throw new Error("The earlier reply is still being reconciled. Wait for it to settle before asking for a follow-up.");
          }
          executions.add(id);
          const words = request.attempt ? continuationPrompt({ objective: prompt, refs: ["earlier group messages in this native thread"], completedActions: [], resumeInstructions: "Finish only the missing group reply." }, [], "Continue the earlier group request from the work already present in this thread. The person explicitly requested this follow-up.") : prompt;
          const entry = await collaboration.submit({ id, owner, groupRequestId: request.id, requestText: request.text, personRequest: request.humanRequest === true && !request.eventRunId && !request.legacyAllHands && !request.attempt, groupReply: { name: participants.find((member) => member.slug === slug).name }, prompt: context ? `${context}\n\n${words}` : words, timeoutMs: replyTimeoutMs, tools: { coworker_team_refer: false, coworker_event_conclude: Boolean(request.eventRunId && request.eventPhase === "conclusion") } });
          return { ...await collaboration.wait(entry.id, signal), executionId: entry.id };
        },
        route: async (input) => {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
          const conversation = request.conversationIdentity ? await withAbort(conversationContext(groupId, request.conversationIdentity), signal) : null;
          const ready = await withAbort(coordinator(signal), signal);
          const current = await getGroup(directory, groupId);
          const catalog = await withAbort(catalogFor(ready, signal), signal);
          const appDefault = (await withAbort(settings(), signal)).modelDefaults.facilitator;
          const models = facilitatorModels(catalog, participants, current.facilitatorModel, appDefault);
          if (!models.primary) return null;
          const prompt = facilitatorPrompt({ group: current, members: participants.map((member) => ({ ...member, busy: false })), recent: input.recent, earlierOrders: earlierSpeakerOrders(current.turns), message: [conversation?.context, request.context, input.message].filter(Boolean).join("\n\n"), mentions: input.mentions, nameFor: (slug) => participants.find((member) => member.slug === slug)?.name ?? slug });
          const client = await withAbort(clientFor(".coordinator", { observationOnly: true, signal }), signal);
          let threadId = current.facilitatorThreadId;
          if (!threadId) {
            threadId = (await withAbort(client.createThread({ title: `Facilitator: ${current.name}`, signal }), signal)).id;
            await updateGroup(directory, groupId, { facilitatorThreadId: threadId }, { authority: EVENT_GROUP_AUTHORITY });
          }
          let attempt = 0;
          return routeWithFacilitator({ ...input, models, prompt, signal, ask: async (words, model) => {
            const id = collaborationId(groupId, request.id, "route", attempt++);
            executions.add(id);
            signal.throwIfAborted();
            const variant = effortForTurn({ kind: "facilitator", stop: "balanced", fixedVariant: !current.facilitatorModel.trim() && appDefault.model ? appDefault.modelVariant : "", variants: model.variants });
            const entry = await collaboration.submit({ id, groupRequestId: request.id, owner: { slug: ".coordinator", threadId, conversationId: groupId, kind: "coordinator", groupId, ...(request.conversationIdentity ? { conversationIdentity: request.conversationIdentity } : {}) }, prompt: words, model: { providerId: model.providerId, modelId: model.modelId, ...(variant ? { variant } : {}) }, timeoutMs: 40_000 });
            const onAbort = () => { void collaboration.cancel(entry.id).catch(() => {}); };
            signal.addEventListener("abort", onAbort, { once: true });
            try { return (await collaboration.wait(entry.id, signal)).text; } finally { signal.removeEventListener("abort", onAbort); }
          } });
        },
      };
      for (const [name, work] of Object.entries(deps)) deps[name] = (...args) => track(work(...args));
      const existing = group.turns.find((turn) => turn.id === request.turnId || turn.clientMessageId === request.id);
      if (existing) {
        await collaboration.change((state) => { const current = state.groups[groupId]?.queue.find((entry) => entry.id === request.id); if (current) current.turnId = existing.id; });
        await appendGroupEvent(directory, groupId, { id: `evt_${existing.id}_user`, kind: "user", text: existing.prompt, turnId: existing.id, clientMessageId: existing.clientMessageId });
        let turn = existing;
        if (!turn.speakers.length) {
          const plan = request.plan ?? fallbackPlan(request.text, participants, timeline);
          turn = await updateGroupTurn(directory, groupId, turn.id, { speakers: planSpeakers(plan), mode: plan.mode, dependsOn: plan.dependsOn, routedBy: plan.routedBy });
        }
        completedTurn = await resumeGroupTurn({ group, participants, turn, events: timeline, only: request.only, deps, signal: controller.signal });
      } else {
        completedTurn = await runGroupTurn({ group, participants, recent: timeline, message: request.text, clientMessageId: request.id, plan: request.plan, deps, signal: controller.signal });
      }
    } catch (error) {
      if (closed) return;
      failure = error.message;
      await appendGroupEvent(directory, groupId, { id: `evt_${collaborationId(request.id, "failure").slice(5)}`, kind: "status", status: controller.signal.aborted ? "stopped" : "failed", text: controller.signal.aborted ? "Stopped. Earlier replies have been kept." : `This turn could not finish: ${error.message}` });
    } finally {
      clearTimeout(deadlineTimer);
      try { if (!closed) {
        if (controller.signal.aborted) await Promise.all([...executions].map((id) => collaboration.cancel(id)));
        await collaboration.change((state) => {
          state.groups[groupId].queue = state.groups[groupId].queue.filter((entry) => entry.id !== request.id);
          if (request.eventRunId) {
            const receipt = state.workplaceEvents.runs[request.eventRunId].requests[request.eventPhase];
            receipt.finished = true;
            receipt.turn = completedTurn ?? null;
            receipt.error = failure;
          }
        });
      } } finally { active.delete(groupId); wake(); }
    }
  }
  function wake() {
    if (closed || serviceError || timer) return;
    timer = setTimeout(() => { timer = null; void pump().catch(() => { if (++failures >= 3) fail(); }).finally(wake); }, pollMs);
    timer.unref?.();
  }
  function fail() {
    serviceError = "Group collaboration paused because its local records could not be read or updated. Existing work has been kept. Restart the app before continuing.";
    clearTimeout(timer);
    for (const { controller } of active.values()) controller.abort(new Error(serviceError));
  }
  async function pump() {
    if (pumping || closed) return;
    pumping = true;
    try {
      const { groups, undelivered } = await collaboration.read((state) => ({ groups: state.groups, undelivered: Object.values(state.executions).filter((entry) => entry.groupReply && entry.state === "succeeded" && entry.result && !entry.groupReply.published) }));
      for (const [id, state] of Object.entries(groups)) {
        if (closed || serviceError || active.has(id)) continue;
        // A recovered queued turn still owns speaker order; only orphaned delivery is drained here.
        const replies = undelivered.filter((entry) => entry.owner.groupId === id && !state.queue.some((request) => request.id === entry.groupRequestId));
        if (replies.length) {
          const group = await getGroup(directory, id);
          const order = (entry) => group.turns.find((turn) => turn.id === entry.owner.turnId)?.speakers.find((speaker) => speaker.slug === entry.owner.slug && speaker.part === (entry.owner.part ?? "reply"))?.order ?? 0;
          replies.sort((a, b) => a.owner.turnId === b.owner.turnId ? order(a) - order(b) : a.createdAt - b.createdAt);
          for (const entry of replies) await publishReply(entry);
        }
        if (state.queue.length) void execute(id, state.queue[0]).catch(fail);
      }
      failures = 0;
    } finally { pumping = false; }
  }
  return {
    participant,
    async start() {
      // Migrate ownership, not histories. Group threads must never be private discussions.
      for (const group of await listGroups(directory)) for (const [slug, threadId] of Object.entries(group.participantThreadIds)) await collaboration.registerOwner({ slug, threadId, conversationId: group.id, groupId: group.id, kind: "group" });
      wake();
    },
    async submit(groupId, input) {
      if (closed || serviceError) throw new Error(serviceError || "Group collaboration is closing.");
      const stored = await getGroup(directory, groupId);
      if (stored.archivedAt !== null) throw new Error("This group is archived.");
      if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 20_000 || typeof input.clientMessageId !== "string" || !input.clientMessageId) throw new Error("A group request needs a message and a stable client id.");
      if (["eventRunId", "eventPhase", "plan", "participantSlugs", "conversationIdentity", "legacyAllHands", "personRequest", "humanRequest"].some((key) => Object.hasOwn(input, key))) throw new Error("Native group execution identity is not writable.");
      const original = input.turnId ? stored.turns.find((turn) => turn.id === input.turnId) : null;
      if (/^(event:|all-hands:)/.test(input.clientMessageId) || /^(event:|all-hands:)/.test(original?.clientMessageId ?? "")) throw new Error("Scheduled Event phase requests are immutable. Continue is available only for ordinary human turns.");
      const identityKey = original?.clientMessageId ?? input.clientMessageId;
      const previousIdentity = stored.eventId ? await collaboration.read((state) => {
        const identities = state.groups[groupId]?.conversationIdentities;
        return identities && Object.hasOwn(identities, identityKey) ? identities[identityKey] : null;
      }) : null;
      const conversation = stored.eventId ? await conversationContext(groupId, previousIdentity) : null;
      await collaboration.change((state) => {
        const group = state.groups[groupId] ??= { queue: [] };
        if (group.cancelledRequestIds?.includes(input.clientMessageId)) throw new Error("This group request was cancelled. Send a new request to continue.");
        group.recoveryRequests ??= [];
        if (group.recoveryRequests.some((receipt) => receipt.id === input.clientMessageId)) return;
        if (input.turnId && !stored.turns.some((turn) => turn.id === input.turnId)) throw new Error("That group turn is not on record.");
        if (!input.turnId && stored.turns.some((turn) => turn.clientMessageId === input.clientMessageId)) return;
        const queued = group.queue.find((entry) => entry.id === input.clientMessageId);
        if (input.turnId && !queued) {
          group.retryCounts ??= {};
          if ((group.retryCounts[input.turnId] ?? 0) >= 2) throw new Error("This group turn reached its follow-up limit. Review the earlier work and send a new request.");
          group.retryCounts[input.turnId] = (group.retryCounts[input.turnId] ?? 0) + 1;
        }
        const request = queued ?? { id: input.clientMessageId, text: input.text, context: input.context ?? "", turnId: input.turnId ?? "", only: input.only, humanRequest: !input.turnId, attempt: input.turnId ? group.retryCounts[input.turnId] : 0,
          ...(conversation ? { conversationIdentity: conversation.identity } : {}) };
        if (conversation) group.conversationIdentities = { ...group.conversationIdentities, [identityKey]: request.conversationIdentity };
        // This acceptance survives dequeue, so an uncertain retry cannot spend another attempt.
        if (request.attempt > 0) group.recoveryRequests.push({ id: request.id, turnId: request.turnId, attempt: request.attempt });
        if (!queued) group.queue.push(request);
      });
      wake();
      return { accepted: true };
    },
    async status(groupId) {
      if (serviceError) throw new Error(serviceError);
      const queue = await collaboration.read((state) => state.groups[groupId]?.queue ?? []);
      const group = await getGroup(directory, groupId);
      const interactions = group.archivedAt === null ? (await collaboration.groupInteractions(groupId)).filter((entry) => group.participantSlugs.includes(entry.slug)) : [];
      return { active: active.has(groupId) || queue.length > 0, interactions, turn: group.turns.find((turn) => turn.id === queue[0]?.turnId || turn.clientMessageId === queue[0]?.id) ?? null, queue: queue.slice(1).map((entry) => ({ clientMessageId: entry.id, text: entry.text })) };
    },
    async activity(groupId, readActivity) {
      const executions = await readActivity({ groupId });
      // Publication may finish during observation. Read its receipt last and return each reply once.
      const timeline = await readGroupTimeline(directory, groupId);
      return { timeline, executions: executions.filter((entry) => !timeline.some((event) => groupMessageKey(event) === `execution:${entry.executionId}` || event.id === entry.timelineEventId)) };
    },
    async replyInteraction(input) {
      const group = await getGroup(directory, input.groupId);
      if (group.archivedAt !== null || !group.participantSlugs.includes(input.slug)) throw new Error("That coworker is no longer in this active group.");
      return collaboration.replyInteraction(input);
    },
    async remove(groupId, id) {
      await collaboration.change((state) => {
        if (/^(event:|all-hands:)/.test(id) || state.groups[groupId]?.queue.some((entry) => entry.id === id && entry.eventRunId)) throw new Error("Cancel the Event run instead of removing its scheduled phase.");
        if (active.get(groupId)?.requestId === id) throw new Error("This group request already started. Stop it instead of removing it from Next.");
        if (state.groups[groupId]) state.groups[groupId].queue = state.groups[groupId].queue.filter((entry) => entry.id !== id);
      });
    },
    async cancelRequest(groupId, requestId) {
      await collaboration.change((state) => {
        const group = state.groups[groupId] ??= { queue: [] };
        group.cancelledRequestIds = [...new Set([...(group.cancelledRequestIds ?? []), requestId])];
        if (active.get(groupId)?.requestId !== requestId) group.queue = group.queue.filter((entry) => entry.id !== requestId);
      });
      if (active.get(groupId)?.requestId === requestId) active.get(groupId).controller.abort(new Error("Stopped."));
    },
    async cancel(groupId) {
      const managed = Boolean((await getGroup(directory, groupId)).eventId);
      let stopping;
      await collaboration.change((state) => {
        const group = state.groups[groupId];
        const queue = group?.queue;
        const requests = managed ? (queue ?? []).filter((entry) => !entry.eventRunId) : queue?.slice(0, 1) ?? [];
        const ids = new Set(requests.map((entry) => entry.id));
        if (group) {
          group.cancelledRequestIds = [...new Set([...(group.cancelledRequestIds ?? []), ...ids])];
          group.queue = managed ? group.queue.filter((entry) => !ids.has(entry.id)) : active.has(groupId) ? group.queue : group.queue.slice(1);
        }
        if (ids.has(active.get(groupId)?.requestId)) stopping = active.get(groupId);
      });
      stopping?.controller.abort(new Error("Stopped."));
      const tasks = await collaboration.read((state) => Object.values(state.tasks).filter((task) => task.owner.groupId === groupId && (!managed || !task.owner.eventRunId)
        && (!["succeeded", "failed", "cancelled"].includes(task.state) || state.executions[task.executionId]?.cleanupPending)));
      await Promise.all(tasks.map((task) => collaboration.cancel(task.id)));
    },
    async stop() {
      closed = true;
      clearTimeout(timer);
      for (const { controller } of active.values()) controller.abort(new Error("The app is closing."));
      const deadline = Date.now() + setupTimeoutMs;
      while ((active.size || pumping || threadLocks.size || pending.size) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      if (active.size || pumping || threadLocks.size || pending.size) throw new Error("Group work did not finish stopping.");
    },
    async consultation(task) {
      if (closed) throw new Error("Group collaboration is closing.");
      const signal = task.signal ?? AbortSignal.timeout(setupTimeoutMs);
      const assertLive = async () => {
        signal.throwIfAborted();
        const current = await withAbort(collaboration.read((state) => state.tasks[task.id]), signal);
        if (!current || current.cancelRequested || ["succeeded", "failed", "cancelled"].includes(current.state)) throw new Error("This consultation has stopped.");
      };
      await assertLive();
      const from = await withAbort(coworkerFor(task.origin.slug), signal);
      const to = await withAbort(coworkerFor(task.to), signal);
      let groupId = task.groupId;
      if (!groupId) {
        const groups = (await withAbort(listGroups(directory), signal)).filter((group) => !group.eventId && group.archivedAt === null && group.participantSlugs.length === 2 && group.participantSlugs.includes(from.slug) && group.participantSlugs.includes(to.slug));
        const originGroup = task.origin.groupId ? await withAbort(getGroup(directory, task.origin.groupId), signal) : null;
        const suitable = originGroup?.archivedAt === null && originGroup.participantSlugs.includes(to.slug) && originGroup.participantSlugs.includes(from.slug) ? originGroup : null;
        await assertLive();
        const group = suitable ?? (groups.length === 1 ? groups[0] : await withAbort(track(createGroup(directory, { id: `grp_${collaborationId(task.id, "pair").slice(5)}`, name: `${from.name} & ${to.name}`, participantSlugs: [from.slug, to.slug] })), signal));
        groupId = group.id;
        await collaboration.change((state) => { signal.throwIfAborted(); if (!state.tasks[task.id].cancelRequested) state.tasks[task.id].groupId = groupId; });
      }
      await assertLive();
      await withAbort(track(appendGroupEvent(directory, groupId, { id: `evt_${collaborationId(task.id, "question").slice(5)}`, kind: "coworker", slug: from.slug, status: "consultation", text: `${to.name}, ${task.input.question}${task.input.context ? `\n\nShared context: ${task.input.context}` : ""}` })), signal);
      // A consultation has its own native history; only the explicitly shared brief crosses over.
      let owner = await collaboration.read((state) => state.tasks[task.id].answerOwner ?? null);
      if (!owner) {
        const client = await withAbort(track(clientFor(to.slug, { observationOnly: true, signal })), signal);
        await assertLive();
        const thread = await withAbort(track(client.createThread({ title: `Question from ${from.name}`, signal })), signal);
        owner = { slug: to.slug, threadId: thread.id, conversationId: groupId, groupId, kind: "consultation", ...(task.origin.eventRunId ? { eventRunId: task.origin.eventRunId, eventPhase: "contributions" } : {}),
          ...(task.origin.conversationIdentity && task.origin.groupId === groupId ? { conversationIdentity: task.origin.conversationIdentity } : {}) };
        await collaboration.change((state) => { signal.throwIfAborted(); if (!state.tasks[task.id].cancelRequested) state.tasks[task.id].answerOwner = owner; });
      }
      await assertLive();
      return { owner, prompt: `You are ${to.name}. ${from.name} asks this focused question in your shared group. Answer the question, not the private task behind it. Only the following explicit brief was shared; no private transcript is available.\n\nQuestion: ${task.input.question}\n\nShared context: ${task.input.context || "none"}\n\nGive a concise answer with evidence or uncertainty. Do not perform external writes without the person's authorization. If a question or approval is necessary, explain the blocker.` };
    },
  };
}

/** Repair only the invalid selection pointer; group history and valid private selections stay intact. */
export async function repairGroupSelection(coworker, groups, update) {
  if (!coworker.conversationThreadId || !groups.some((group) => group.participantThreadIds[coworker.slug] === coworker.conversationThreadId)) return coworker;
  return update(coworker.slug, { conversationThreadId: "" });
}
