import { createGroup, getGroup, listGroups, beginGroupTurn, updateGroup, updateGroupTurn, appendGroupEvent, readGroupTimeline } from "./groups.mjs";
import { collaborationId, withAbort } from "./collaboration.mjs";
import { runGroupTurn, resumeGroupTurn, fallbackPlan, parseMentions, MAX_SPEAKERS_PER_TURN } from "../src/lib/groups.ts";
import { facilitatorPrompt, earlierSpeakerOrders, routeWithFacilitator, facilitatorModels } from "../src/lib/facilitator.ts";

/** The window only submits requests and reads projections. All group execution
 * and cancellation remain alive when that window navigates or reloads. */
export function createGroupExecution({ directory, collaboration, coworkerFor, coordinator, catalogFor, clientFor, setupTimeoutMs = 30_000, replyTimeoutMs = 180_000, pollMs = 750 }) {
  const active = new Map();
  let timer;
  let closed = false;
  let pumping = false;
  let failures = 0;
  let serviceError = "";
  const threadLocks = new Map();
  async function participant(groupId, slug, signal = AbortSignal.timeout(setupTimeoutMs)) {
    const key = `${groupId}:${slug}`;
    const previous = threadLocks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      signal.throwIfAborted();
      const group = await withAbort(getGroup(directory, groupId), signal);
      if (group.archivedAt !== null || !group.participantSlugs.includes(slug)) throw new Error("That coworker is no longer in this active group.");
      let threadId = group.participantThreadIds[slug];
      if (!threadId) {
        const client = await withAbort(clientFor(slug, { signal }), signal);
        signal.throwIfAborted();
        const thread = await withAbort(client.createThread({ title: `Group chat: ${group.name}`, signal }), signal);
        threadId = thread.id;
        await updateGroup(directory, groupId, { participantThreadIds: { [slug]: threadId } });
      }
      const owner = { slug, threadId, conversationId: groupId, groupId, kind: "group" };
      signal.throwIfAborted();
      await withAbort(collaboration.registerOwner(owner), signal);
      return owner;
    });
    threadLocks.set(key, run);
    try { return await withAbort(run, signal); } finally { if (threadLocks.get(key) === run) threadLocks.delete(key); }
  }
  async function execute(groupId, request) {
    if (closed || serviceError || active.has(groupId)) return;
    const controller = new AbortController();
    active.set(groupId, controller);
    const executions = new Set();
    try {
      const current = await collaboration.read((state) => state.groups[groupId]);
      if (closed || current?.cancelledRequestIds?.includes(request.id) || !current?.queue.some((entry) => entry.id === request.id)) return;
      const setupSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(setupTimeoutMs)]);
      let group = await withAbort(getGroup(directory, groupId), setupSignal);
      if (group.archivedAt !== null) throw new Error("The group is archived.");
      const participants = await withAbort(Promise.all(group.participantSlugs.map(coworkerFor)), setupSignal);
      const timeline = await withAbort(readGroupTimeline(directory, groupId), setupSignal);
      const mentions = parseMentions(request.text, participants);
      const boundedSpeakers = (speakers) => !mentions.everyone && !mentions.slugs.length ? speakers.slice(0, MAX_SPEAKERS_PER_TURN) : speakers;
      const deps = {
        begin: async (input) => {
          const begun = await beginGroupTurn(directory, groupId, input);
          await collaboration.change((state) => { const current = state.groups[groupId]?.queue.find((entry) => entry.id === request.id); if (current) current.turnId = begun.turn.id; });
          return begun;
        },
        record: (turnId, patch) => updateGroupTurn(directory, groupId, turnId, patch.speakers ? { ...patch, speakers: boundedSpeakers(patch.speakers) } : patch),
        append: (event) => appendGroupEvent(directory, groupId, { ...event, id: `evt_${collaborationId(event.turnId, event.slug, event.part, event.kind, event.status, event.text).slice(5)}` }),
        ask: async (slug, prompt, signal, step) => {
          const owner = { ...await participant(groupId, slug, AbortSignal.any([signal, AbortSignal.timeout(setupTimeoutMs)])), turnId: step.turnId, part: step.part };
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
          const words = request.attempt ? `Continue the earlier group request from the work already present in this thread. This is a follow-up, not permission to repeat completed tool actions. Inspect the existing results, state what was completed, and perform only missing work. If an earlier action's outcome is uncertain, ask the person instead of repeating it.\n\nOriginal objective and current group context:\n${prompt}` : prompt;
          const entry = await collaboration.submit({ id, owner, groupRequestId: request.id, prompt: request.context ? `${request.context}\n\n${words}` : words, timeoutMs: replyTimeoutMs, tools: { coworker_team_refer: false } });
          return collaboration.wait(entry.id, signal);
        },
        route: async (input) => {
          if (!input.mentions.everyone && input.mentions.slugs.length === 1) return null;
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
          const ready = await withAbort(coordinator(signal), signal);
          const current = await getGroup(directory, groupId);
          const catalog = await withAbort(catalogFor(ready, signal), signal);
          const models = facilitatorModels(catalog, participants, current.facilitatorModel);
          if (!models.primary) return null;
          const prompt = facilitatorPrompt({ group: current, members: participants.map((member) => ({ ...member, busy: false })), recent: input.recent, earlierOrders: earlierSpeakerOrders(current.turns), message: request.context ? `${request.context}\n\n${input.message}` : input.message, mentions: input.mentions, nameFor: (slug) => participants.find((member) => member.slug === slug)?.name ?? slug });
          const client = await withAbort(clientFor(".coordinator", { signal }), signal);
          let threadId = current.facilitatorThreadId;
          if (!threadId) {
            threadId = (await withAbort(client.createThread({ title: `Facilitator: ${current.name}`, signal }), signal)).id;
            await updateGroup(directory, groupId, { facilitatorThreadId: threadId });
          }
          let attempt = 0;
          return routeWithFacilitator({ ...input, models, prompt, signal, ask: async (words, model) => {
            const id = collaborationId(groupId, request.id, "route", attempt++);
            executions.add(id);
            signal.throwIfAborted();
            const entry = await collaboration.submit({ id, groupRequestId: request.id, owner: { slug: ".coordinator", threadId, conversationId: groupId, kind: "coordinator", groupId }, prompt: words, model: { providerId: model.providerId, modelId: model.modelId, ...(model.variants[0] ? { variant: model.variants[0] } : {}) }, timeoutMs: 40_000 });
            const onAbort = () => { void collaboration.cancel(entry.id); };
            signal.addEventListener("abort", onAbort, { once: true });
            try { return (await collaboration.wait(entry.id, signal)).text; } finally { signal.removeEventListener("abort", onAbort); }
          } });
        },
      };
      const existing = group.turns.find((turn) => turn.id === request.turnId || turn.clientMessageId === request.id);
      if (existing) {
        await appendGroupEvent(directory, groupId, { id: `evt_${existing.id}_user`, kind: "user", text: existing.prompt, turnId: existing.id, clientMessageId: existing.clientMessageId });
        let turn = existing;
        if (boundedSpeakers(turn.speakers).length !== turn.speakers.length) turn = await updateGroupTurn(directory, groupId, turn.id, { speakers: boundedSpeakers(turn.speakers) });
        if (!turn.speakers.length) turn = await updateGroupTurn(directory, groupId, turn.id, { speakers: fallbackPlan(request.text, participants, timeline).speakers, mode: "sequential" });
        await resumeGroupTurn({ group, participants, turn, events: timeline, only: request.only, deps, signal: controller.signal });
      } else {
        await runGroupTurn({ group, participants, recent: timeline, message: request.text, clientMessageId: request.id, deps, signal: controller.signal });
      }
    } catch (error) {
      if (closed) return;
      await appendGroupEvent(directory, groupId, { id: `evt_${collaborationId(request.id, "failure").slice(5)}`, kind: "status", status: controller.signal.aborted ? "stopped" : "failed", text: controller.signal.aborted ? "Stopped. Earlier replies have been kept." : `This turn could not finish: ${error.message}` });
    } finally {
      try { if (!closed) {
        if (controller.signal.aborted) await Promise.all([...executions].map((id) => collaboration.cancel(id)));
        await collaboration.change((state) => { state.groups[groupId].queue = state.groups[groupId].queue.filter((entry) => entry.id !== request.id); });
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
    for (const controller of active.values()) controller.abort(new Error(serviceError));
  }
  async function pump() {
    if (pumping || closed) return;
    pumping = true;
    try {
      const groups = await collaboration.read((state) => state.groups);
      for (const [id, state] of Object.entries(groups)) if (!closed && !serviceError && !active.has(id) && state.queue.length) void execute(id, state.queue[0]).catch(fail);
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
      const group = await getGroup(directory, groupId);
      if (group.archivedAt !== null) throw new Error("This group is archived.");
      if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 20_000 || typeof input.clientMessageId !== "string" || !input.clientMessageId) throw new Error("A group request needs a message and a stable client id.");
      if (input.turnId && !group.turns.some((turn) => turn.id === input.turnId)) throw new Error("That group turn is not on record.");
      if (!input.turnId && group.turns.some((turn) => turn.clientMessageId === input.clientMessageId)) return { accepted: true };
      await collaboration.change((state) => {
        const group = state.groups[groupId] ??= { queue: [] };
        if (group.cancelledRequestIds?.includes(input.clientMessageId)) throw new Error("This group request was cancelled. Send a new request to continue.");
        if (input.turnId && !group.queue.some((entry) => entry.id === input.clientMessageId)) {
          group.retryCounts ??= {};
          if ((group.retryCounts[input.turnId] ?? 0) >= 2) throw new Error("This group turn reached its follow-up limit. Review the earlier work and send a new request.");
          group.retryCounts[input.turnId] = (group.retryCounts[input.turnId] ?? 0) + 1;
        }
        if (!group.queue.some((entry) => entry.id === input.clientMessageId)) group.queue.push({ id: input.clientMessageId, text: input.text, context: input.context ?? "", turnId: input.turnId ?? "", only: input.only, attempt: input.turnId ? group.retryCounts[input.turnId] : 0 });
      });
      wake();
      return { accepted: true };
    },
    async status(groupId) {
      if (serviceError) throw new Error(serviceError);
      const queue = await collaboration.read((state) => state.groups[groupId]?.queue ?? []);
      const group = await getGroup(directory, groupId);
      return { active: active.has(groupId) || queue.length > 0, turn: group.turns.find((turn) => turn.id === queue[0]?.turnId || turn.clientMessageId === queue[0]?.id) ?? null, queue: queue.slice(1).map((entry) => ({ clientMessageId: entry.id, text: entry.text })) };
    },
    async remove(groupId, id) { await collaboration.change((state) => { if (state.groups[groupId]) state.groups[groupId].queue = state.groups[groupId].queue.filter((entry) => entry.id !== id); }); },
    async cancel(groupId) {
      await collaboration.change((state) => {
        const group = state.groups[groupId];
        const queue = group?.queue;
        if (queue?.length) group.cancelledRequestIds = [...new Set([...(group.cancelledRequestIds ?? []), queue[0].id])];
        if (queue?.length && !active.has(groupId)) queue.shift();
      });
      active.get(groupId)?.abort(new Error("Stopped."));
      const tasks = await collaboration.read((state) => Object.values(state.tasks).filter((task) => task.owner.groupId === groupId && !["succeeded", "failed", "cancelled"].includes(task.state)));
      await Promise.all(tasks.map((task) => collaboration.cancel(task.id)));
    },
    stop() { closed = true; clearTimeout(timer); for (const controller of active.values()) controller.abort(new Error("The app is closing.")); },
    async consultation(task) {
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
        const groups = (await withAbort(listGroups(directory), signal)).filter((group) => group.archivedAt === null && group.participantSlugs.length === 2 && group.participantSlugs.includes(from.slug) && group.participantSlugs.includes(to.slug));
        const originGroup = task.origin.groupId ? await withAbort(getGroup(directory, task.origin.groupId), signal) : null;
        const suitable = originGroup?.archivedAt === null && originGroup.participantSlugs.includes(to.slug) && originGroup.participantSlugs.includes(from.slug) ? originGroup : null;
        await assertLive();
        const group = suitable ?? (groups.length === 1 ? groups[0] : await withAbort(createGroup(directory, { id: `grp_${collaborationId(task.id, "pair").slice(5)}`, name: `${from.name} & ${to.name}`, participantSlugs: [from.slug, to.slug] }), signal));
        groupId = group.id;
        await collaboration.change((state) => { signal.throwIfAborted(); if (!state.tasks[task.id].cancelRequested) state.tasks[task.id].groupId = groupId; });
      }
      await assertLive();
      await withAbort(appendGroupEvent(directory, groupId, { id: `evt_${collaborationId(task.id, "question").slice(5)}`, kind: "coworker", slug: from.slug, status: "consultation", text: `${to.name}, ${task.input.question}${task.input.context ? `\n\nShared context: ${task.input.context}` : ""}` }), signal);
      // A consultation has its own native history; only the explicitly shared brief crosses over.
      let owner = await collaboration.read((state) => state.tasks[task.id].answerOwner ?? null);
      if (!owner) {
        const client = await withAbort(clientFor(to.slug, { signal }), signal);
        await assertLive();
        const thread = await withAbort(client.createThread({ title: `Question from ${from.name}`, signal }), signal);
        owner = { slug: to.slug, threadId: thread.id, conversationId: groupId, groupId, kind: "consultation" };
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
