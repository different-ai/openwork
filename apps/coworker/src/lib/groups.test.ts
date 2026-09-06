import assert from "node:assert/strict";
import test from "node:test";
import type { CoworkerGroupTurn, GroupSpeakerRun, GroupTimelineEvent, GroupTurnPatch } from "./bridge.ts";
import {
  chooseSpeakers,
  describeGroupActivity,
  describeSpeakerFailure,
  describeTurnProgress,
  fallbackPlan,
  unavailableModelReason,
  groupSpeakerPrompt,
  isNothingToAdd,
  mentionCandidates,
  parseMentions,
  planSpeakers,
  replyTextSince,
  resumeGroupTurn,
  runGroupTurn,
  suggestGroupName,
  type GroupTurnDeps,
  type RoutingPlan,
} from "./groups.ts";

const scout = { slug: "scout", name: "Scout", role: "Research partner", mission: "Find and check sources for the team." };
const editor = { slug: "editor", name: "Editor", role: "Writing partner", mission: "Shape drafts into clear writing." };
const ops = { slug: "ops", name: "Ops Lead", role: "", mission: "" };
const team = [scout, editor, ops];

function event(partial: Partial<GroupTimelineEvent> & Pick<GroupTimelineEvent, "kind" | "text">): GroupTimelineEvent {
  return { id: `evt_${Math.random().toString(36).slice(2)}`, at: 1, ...partial };
}

/** The store's rule, mirrored: a turn's status follows its speakers unless set explicitly. */
function deriveStatus(speakers: GroupSpeakerRun[]): CoworkerGroupTurn["status"] {
  if (speakers.length === 0) return "routing";
  if (speakers.some((speaker) => speaker.status === "queued" || speaker.status === "running")) return "running";
  const finished = speakers.filter((speaker) => speaker.status === "succeeded" || speaker.status === "passed").length;
  if (finished === speakers.length) return "succeeded";
  if (finished > 0) return "partial";
  return speakers.every((speaker) => speaker.status === "failed") ? "failed" : "stopped";
}

/** An in-memory stand-in for `electron/groups.mjs`: turns keyed by client message id, events appended in order. */
function fakeStore(initialEvents: GroupTimelineEvent[] = []) {
  const turns = new Map<string, CoworkerGroupTurn>();
  const events: GroupTimelineEvent[] = [...initialEvents];
  const published: string[] = [];
  let clock = 100;
  const speakerFrom = (input: NonNullable<GroupTurnPatch["speakers"]>[number], order: number): GroupSpeakerRun => ({
    slug: input.slug,
    order,
    status: input.status ?? "queued",
    part: input.part ?? "reply",
    brief: input.brief ?? "",
    threadId: input.threadId ?? "",
    error: input.error ?? "",
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
  });
  const deps: Pick<GroupTurnDeps, "append" | "begin" | "record" | "onTurn" | "now"> = {
    now: () => (clock += 1),
    append: async (input) => {
      const stored = { id: `evt_${events.length + 1}`, at: (clock += 1), ...input };
      events.push(stored);
      return stored;
    },
    begin: async ({ clientMessageId, prompt }) => {
      const existing = [...turns.values()].find((turn) => turn.clientMessageId === clientMessageId);
      if (existing) return { turn: existing, created: false, userEvent: null };
      const turn: CoworkerGroupTurn = { id: `turn_${turns.size + 1}`, clientMessageId, prompt, createdAt: clock, updatedAt: clock, status: "routing", mode: "sequential", routedBy: "fallback", speakers: [] };
      turns.set(turn.id, turn);
      const userEvent = await deps.append({ kind: "user", text: prompt, turnId: turn.id, clientMessageId });
      return { turn, created: true, userEvent };
    },
    record: async (turnId, patch) => {
      const current = turns.get(turnId);
      if (!current) throw new Error("no turn");
      let speakers = current.speakers;
      if (patch.speakers) speakers = patch.speakers.map(speakerFrom);
      if (patch.speaker) {
        const { slug, part = "reply", ...changes } = patch.speaker;
        const index = speakers.findIndex((speaker) => speaker.slug === slug && speaker.part === part);
        if (index === -1) throw new Error(`not part of the turn: ${slug}`);
        const previous = speakers[index];
        if (!previous) throw new Error("missing speaker");
        speakers = speakers.with(index, { ...previous, ...changes, slug, part });
      }
      const next: CoworkerGroupTurn = { ...current, speakers, mode: patch.mode ?? current.mode, routedBy: patch.routedBy ?? current.routedBy, status: patch.status ?? deriveStatus(speakers), updatedAt: clock };
      turns.set(turnId, next);
      return next;
    },
    onTurn: (turn) => published.push(`${turn.status}:${turn.speakers.map((speaker) => `${speaker.slug}=${speaker.status}`).join(",")}`),
  };
  return { deps, turns, events, published };
}

test("mentions name coworkers by handle or first name, once each, and @everyone includes all", () => {
  assert.deepEqual(parseMentions("@Editor and @scout, then @editor again", team), { everyone: false, slugs: ["editor", "scout"] });
  assert.deepEqual(parseMentions("@ops what do you think", team), { everyone: false, slugs: ["ops"] });
  assert.deepEqual(parseMentions("email me at me@example.com", team), { everyone: false, slugs: [] });
  assert.deepEqual(parseMentions("@everyone weigh in", team), { everyone: true, slugs: [] });
  // Punctuation and brackets around a handle do not hide it; @everyone with names keeps the names for ordering.
  assert.deepEqual(parseMentions("(@Scout) and @editor: thoughts?", team), { everyone: false, slugs: ["scout", "editor"] });
  assert.deepEqual(parseMentions("@everyone, @scout first", team), { everyone: true, slugs: ["scout"] });
  assert.deepEqual(parseMentions("@Scout-", team), { everyone: false, slugs: ["scout"] });
  assert.deepEqual(parseMentions("nobody here is @stranger", team), { everyone: false, slugs: [] });
  assert.deepEqual(mentionCandidates("e", team).map((member) => member.slug), ["editor"]);
  assert.deepEqual(mentionCandidates("", team).map((member) => member.slug), ["scout", "editor", "ops"]);
  assert.deepEqual(mentionCandidates("lea", team).map((member) => member.slug), ["ops"]);
});

test("the fallback picks one coworker by role and mission unless the message names who answers", () => {
  assert.deepEqual(chooseSpeakers("Can you check the sources in this research?", team), ["scout"]);
  assert.deepEqual(chooseSpeakers("Tighten the writing in this draft", team), ["editor"]);
  assert.deepEqual(chooseSpeakers("@Editor @scout both look at this", team), ["editor", "scout"]);
  assert.deepEqual(chooseSpeakers("@everyone quick thoughts", team), ["scout", "editor", "ops"]);
  // With no signal at all, the coworker who spoke last keeps the floor; a fresh group falls to the first member.
  assert.deepEqual(chooseSpeakers("thanks, go on", team, [event({ kind: "coworker", slug: "editor", text: "Here is a draft." })]), ["editor"]);
  assert.deepEqual(chooseSpeakers("thanks, go on", team), ["scout"]);
  assert.deepEqual(chooseSpeakers("anything", []), []);
  assert.equal(fallbackPlan("@scout go", team, []).routedBy, "mentions");
  assert.equal(fallbackPlan("check the sources", team, []).routedBy, "fallback");
  const plan: RoutingPlan = { speakers: [{ slug: "scout", brief: "Sources." }, { slug: "editor", brief: "" }], mode: "sequential", dependsOn: [], followUp: { slug: "scout", brief: "React to Editor." }, synthesizer: "editor", routedBy: "facilitator" };
  assert.deepEqual(planSpeakers(plan), [
    { slug: "scout", brief: "Sources.", part: "reply" },
    { slug: "editor", brief: "", part: "reply" },
    { slug: "scout", brief: "React to Editor.", part: "follow-up" },
    { slug: "editor", brief: "", part: "wrap-up" },
  ]);
});

test("a group name comes from roles when they exist, otherwise from names", () => {
  assert.equal(suggestGroupName([scout, editor]), "Research & Writing");
  assert.equal(suggestGroupName([scout, editor, ops]), "Research & Writing");
  assert.equal(suggestGroupName([ops, { ...ops, slug: "care", name: "Care" }]), "Ops Lead & Care");
  assert.equal(suggestGroupName([{ ...scout, role: "Research" }, { ...editor, role: "Research" }]), "Research desk");
});

test("a speaker's prompt carries the room, the recent visible conversation, earlier replies, its part, and the message only", () => {
  const recent = [
    event({ kind: "user", text: "Hello both" }),
    event({ kind: "status", text: "Scout could not reply: offline" }),
    event({ kind: "action", slug: "editor", text: "Assignment for Editor · Draft" }),
    event({ kind: "coworker", slug: "scout", text: "Hi from Scout" }),
  ];
  const prompt = groupSpeakerPrompt({
    group: { name: "Desk" },
    speaker: editor,
    participants: [scout, editor],
    message: "What should the intro say?",
    recent,
    earlierReplies: [{ name: "Scout", text: "Lead with the finding." }],
    nameFor: (slug) => (slug === "scout" ? "Scout" : slug),
    brief: "Propose the first sentence.",
  });
  assert.match(prompt, /^You are Editor, Writing partner, in the group chat "Desk" with the person and Scout \(Research partner\)\./);
  assert.match(prompt, /Your part in this reply: Propose the first sentence\./);
  assert.match(prompt, /add something new/);
  assert.match(prompt, /reply with exactly "Nothing to add\." and nothing else/);
  assert.match(prompt, /- Person: Hello both\n- Scout: Hi from Scout/);
  assert.doesNotMatch(prompt, /could not reply/);
  assert.doesNotMatch(prompt, /Assignment for Editor/);
  assert.match(prompt, /Already said in reply to this message:\n- Scout: Lead with the finding\./);
  assert.match(prompt, /The person's message: What should the intro say\?$/);

  // Without a brief the speaker still gets a sensible default; a wrap-up and a follow-up read differently.
  const plain = groupSpeakerPrompt({ group: { name: "Desk" }, speaker: editor, participants: [editor], message: "Go", recent: [], earlierReplies: [], nameFor: (slug) => slug });
  assert.match(plain, /Your part in this reply: answer the person for your part, from your role\./);
  const wrap = groupSpeakerPrompt({ group: { name: "Desk" }, speaker: editor, participants: [editor], message: "Go", recent: [], earlierReplies: [{ name: "Scout", text: "A" }], nameFor: (slug) => slug, part: "wrap-up" });
  assert.match(wrap, /two or three sentences/);
  assert.doesNotMatch(wrap, /add something new/);
  const follow = groupSpeakerPrompt({ group: { name: "Desk" }, speaker: editor, participants: [editor], message: "Go", recent: [], earlierReplies: [], nameFor: (slug) => slug, part: "follow-up" });
  assert.match(follow, /Your part in this reply: respond to what the other coworkers just said/);
  // Only the last RECENT_CONTEXT_EVENTS visible lines are carried.
  const long = Array.from({ length: 20 }, (_, index) => event({ kind: "user", text: `line ${index}` }));
  const bounded = groupSpeakerPrompt({ group: { name: "Desk" }, speaker: editor, participants: [editor], message: "Go", recent: long, earlierReplies: [], nameFor: (slug) => slug });
  assert.doesNotMatch(bounded, /line 7\b/);
  assert.match(bounded, /line 8\b/);
});

test("reply text is the visible assistant text after the accepted turn", () => {
  const messages = [
    { role: "user", parts: [{ type: "text", text: "old" }] },
    { role: "assistant", parts: [{ type: "text", text: "old reply" }] },
    { role: "user", parts: [{ type: "text", text: "new" }] },
    { role: "assistant", parts: [{ type: "reasoning", text: "hidden" }, { type: "text", text: "First. " }, { type: "text", text: "Second.", synthetic: true }, { type: "text", text: "Third." }] },
  ];
  assert.equal(replyTextSince(messages, 3), "First. \nThird.");
  assert.equal(replyTextSince(messages, 4), "");
  assert.equal(isNothingToAdd("Nothing to add."), true);
  assert.equal(isNothingToAdd("  nothing more to add  "), true);
  assert.equal(isNothingToAdd("Nothing to add, except that the date moved."), false);
});

test("plain lines name who is replying, who is next, and why a speaker did not reply", () => {
  const nameFor = (slug: string) => ({ scout: "Scout", editor: "Editor", ops: "Ops" })[slug] ?? slug;
  assert.equal(describeGroupActivity([], nameFor), "No messages yet");
  assert.equal(describeGroupActivity([event({ kind: "user", text: "hi" })], nameFor), "Waiting for a reply");
  assert.equal(describeGroupActivity([event({ kind: "user", text: "hi" }), event({ kind: "coworker", slug: "scout", text: "hey" }), event({ kind: "status", text: "s" })], nameFor), "Scout replied");
  assert.equal(describeGroupActivity([], nameFor, { status: "routing", speakers: [] }), "Choosing who should respond…");
  const speakers = (statuses: GroupSpeakerRun["status"][]): GroupSpeakerRun[] => statuses.map((status, index) => ({ slug: ["scout", "editor", "ops"][index] ?? "x", order: index, status, part: "reply", brief: "", threadId: "", error: "", startedAt: null, endedAt: null }));
  assert.equal(describeGroupActivity([], nameFor, { status: "running", speakers: speakers(["succeeded", "running", "queued"]) }), "Editor is replying…");
  assert.equal(describeTurnProgress({ status: "running", speakers: speakers(["running", "queued", "queued"]) }, nameFor), "Scout is replying… then Editor and Ops");
  assert.equal(describeTurnProgress({ status: "running", speakers: speakers(["running", "running"]) }, nameFor), "Scout and Editor are replying…");
  assert.equal(describeTurnProgress({ status: "running", speakers: speakers(["queued", "queued", "queued"]) }, nameFor), "Starting with Scout… then Editor and Ops");
  assert.equal(describeTurnProgress({ status: "running", speakers: speakers(["succeeded", "queued"]) }, nameFor), "Starting with Editor…");
  assert.equal(describeTurnProgress({ status: "succeeded", speakers: speakers(["succeeded"]) }, nameFor), "");
  assert.deepEqual(describeSpeakerFailure("Editor took too long to reply.", "Editor"), { headline: "Editor took too long to reply.", modelRelated: false });
  assert.deepEqual(describeSpeakerFailure("Stopped when the app closed", "Editor"), { headline: "Editor was stopped when the app closed.", modelRelated: false });
  assert.deepEqual(describeSpeakerFailure('The saved model "x/y" is not available', "Editor"), { headline: "Editor's AI model is not available.", modelRelated: true });
  assert.deepEqual(describeSpeakerFailure("socket hang up", "Editor"), { headline: "Editor couldn't reach the AI model.", modelRelated: true });
  assert.deepEqual(describeSpeakerFailure("Tool execution failed: permission denied", "Editor"), { headline: "Editor could not reply.", modelRelated: false });
  const connected = [{ id: "opencode/big-pickle", providerId: "opencode", providerLabel: "OpenCode" }];
  assert.equal(unavailableModelReason("", connected), "");
  assert.equal(unavailableModelReason("opencode/big-pickle", connected), "");
  assert.equal(unavailableModelReason("opencode/other", connected), 'The saved model "opencode/other" is not offered by OpenCode any more. Choose another of its AI models.');
  assert.equal(unavailableModelReason("missing-provider/missing-model", connected), 'The saved model "missing-provider/missing-model" is not available: provider "missing-provider" is not connected on this Mac. Choose another AI model or connect that provider in OpenWork.');
  assert.equal(describeSpeakerFailure(unavailableModelReason("missing-provider/missing-model", connected), "Editor").headline, "Editor's AI model is not available.");
});

test("a group turn is recorded through the store, asks each speaker in order with earlier replies, and keeps going past one failure", async () => {
  const store = fakeStore();
  const asked: { slug: string; prompt: string }[] = [];
  const result = await runGroupTurn({
    group: { id: "grp_x", name: "Desk" },
    participants: team,
    recent: [],
    message: "@scout @editor @ops plan the launch note",
    clientMessageId: "m1",
    signal: new AbortController().signal,
    deps: {
      ...store.deps,
      ask: async (slug, prompt) => {
        asked.push({ slug, prompt });
        if (slug === "editor") throw new Error("model unavailable");
        return { text: slug === "scout" ? "Sources are ready." : "Ops can ship Friday.", threadId: `ses_${slug}` };
      },
    },
  });
  assert.ok(result);
  assert.deepEqual(asked.map((entry) => entry.slug), ["scout", "editor", "ops"]);
  const [firstAsk, , thirdAsk] = asked;
  if (!firstAsk || !thirdAsk) throw new Error("Expected three speakers to be asked.");
  assert.doesNotMatch(firstAsk.prompt, /Already said/);
  assert.match(thirdAsk.prompt, /Already said in reply to this message:\n- Scout: Sources are ready\./);
  // The message being answered appears once, at the end, not again as recent conversation.
  assert.doesNotMatch(thirdAsk.prompt, /- Person: @scout @editor @ops plan the launch note/);
  assert.match(thirdAsk.prompt, /The person's message: @scout @editor @ops plan the launch note$/);
  assert.deepEqual(store.events.map((entry) => [entry.kind, entry.slug ?? "", entry.status ?? "", entry.turnId]), [
    ["user", "", "", "turn_1"],
    ["coworker", "scout", "", "turn_1"],
    ["status", "editor", "failed", "turn_1"],
    ["coworker", "ops", "", "turn_1"],
  ]);
  assert.equal(store.events[2]?.text, "Editor's AI model could not answer.");
  assert.equal(result.status, "partial");
  assert.equal(result.routedBy, "mentions");
  assert.deepEqual(result.speakers.map((speaker) => [speaker.slug, speaker.status, speaker.threadId, speaker.error]), [
    ["scout", "succeeded", "ses_scout", ""],
    ["editor", "failed", "", "model unavailable"],
    ["ops", "succeeded", "ses_ops", ""],
  ]);
  assert.ok(result.speakers.every((speaker) => speaker.startedAt !== null && speaker.endedAt !== null));
  assert.equal(store.published[0], "routing:");
  assert.equal(store.published[1], "running:scout=queued,editor=queued,ops=queued");
  assert.equal(store.published.at(-1), "partial:scout=succeeded,editor=failed,ops=succeeded");

  // A double Send finds the turn already open and does nothing more.
  const again = await runGroupTurn({ group: { id: "grp_x", name: "Desk" }, participants: team, recent: [], message: "@scout @editor @ops plan the launch note", clientMessageId: "m1", signal: new AbortController().signal, deps: { ...store.deps, ask: async () => { throw new Error("must not ask"); } } });
  assert.equal(again, null);
  assert.equal(store.events.filter((entry) => entry.kind === "user").length, 1);
});

test("a facilitator plan orders the speakers, adds a follow-up and wrap-up, and its briefs reach the prompts", async () => {
  const store = fakeStore();
  const asked: { slug: string; prompt: string }[] = [];
  const plan: RoutingPlan = {
    speakers: [{ slug: "editor", brief: "Say what the note must promise." }, { slug: "scout", brief: "Check the claim." }],
    mode: "parallel",
    dependsOn: [["scout", "editor"]],
    followUp: { slug: "editor", brief: "Fold in what Scout found." },
    synthesizer: "ops",
    routedBy: "facilitator",
  };
  const result = await runGroupTurn({
    group: { id: "grp_x", name: "Desk" },
    participants: team,
    recent: [],
    message: "Plan the launch note",
    clientMessageId: "m2",
    signal: new AbortController().signal,
    deps: {
      ...store.deps,
      route: async () => plan,
      ask: async (slug, prompt) => {
        asked.push({ slug, prompt });
        return { text: `${slug} says ${asked.length}`, threadId: `ses_${slug}` };
      },
    },
  });
  assert.ok(result);
  assert.equal(result.mode, "sequential", "a dependency keeps the round sequential");
  assert.equal(result.routedBy, "facilitator");
  assert.deepEqual(asked.map((entry) => entry.slug), ["editor", "scout", "editor", "ops"]);
  assert.match(asked[0]?.prompt ?? "", /Your part in this reply: Say what the note must promise\./);
  assert.match(asked[1]?.prompt ?? "", /Already said in reply to this message:\n- Editor: editor says 1/);
  assert.match(asked[2]?.prompt ?? "", /Your part in this reply: Fold in what Scout found\./);
  assert.match(asked[2]?.prompt ?? "", /- Editor: editor says 1\n- Scout: scout says 2/);
  assert.match(asked[3]?.prompt ?? "", /wrap the round up/);
  assert.match(asked[3]?.prompt ?? "", /- Editor: editor says 3/);
  assert.deepEqual(result.speakers.map((speaker) => [speaker.slug, speaker.part, speaker.status]), [
    ["editor", "reply", "succeeded"],
    ["scout", "reply", "succeeded"],
    ["editor", "follow-up", "succeeded"],
    ["ops", "wrap-up", "succeeded"],
  ]);
  assert.equal(store.events.filter((entry) => entry.kind === "coworker").length, 4);
});

test("independent parallel replies settle into the timeline in the facilitator's order", async () => {
  const store = fakeStore();
  const plan: RoutingPlan = { speakers: [{ slug: "scout", brief: "" }, { slug: "editor", brief: "" }], mode: "parallel", dependsOn: [], followUp: null, synthesizer: null, routedBy: "facilitator" };
  const started: string[] = [];
  let releaseScout: (() => void) | null = null;
  const result = await runGroupTurn({
    group: { id: "grp_x", name: "Desk" },
    participants: team,
    recent: [],
    message: "Both of you",
    clientMessageId: "m3",
    signal: new AbortController().signal,
    deps: {
      ...store.deps,
      route: async () => plan,
      ask: async (slug) => {
        started.push(slug);
        if (slug === "scout") await new Promise<void>((resolve) => { releaseScout = resolve; });
        // Editor settles first; its bubble still waits for Scout's.
        if (slug === "editor") setTimeout(() => releaseScout?.(), 5);
        return { text: `${slug} done`, threadId: `ses_${slug}` };
      },
    },
  });
  assert.ok(result);
  assert.deepEqual(started, ["scout", "editor"]);
  assert.equal(result.mode, "parallel");
  assert.deepEqual(store.events.filter((entry) => entry.kind === "coworker").map((entry) => entry.slug), ["scout", "editor"]);
  assert.ok(store.published.includes("running:scout=running,editor=running"), "both speakers were running at once");
});

test("a speaker with nothing to add becomes a quiet line, not a bubble", async () => {
  const store = fakeStore();
  const result = await runGroupTurn({
    group: { id: "grp_x", name: "Desk" },
    participants: team,
    recent: [],
    message: "@scout @editor anything?",
    clientMessageId: "m4",
    signal: new AbortController().signal,
    deps: { ...store.deps, ask: async (slug) => ({ text: slug === "scout" ? "Nothing to add." : "One thing: the date.", threadId: "ses" }) },
  });
  assert.ok(result);
  assert.deepEqual(store.events.map((entry) => [entry.kind, entry.status ?? "", entry.text]), [
    ["user", "", "@scout @editor anything?"],
    ["status", "passed", "Scout had nothing to add."],
    ["coworker", "", "One thing: the date."],
  ]);
  assert.deepEqual(result.speakers.map((speaker) => speaker.status), ["passed", "succeeded"]);
  assert.equal(result.status, "succeeded");
});

test("stopping a group turn marks the in-flight speaker and the rest stopped without asking them", async () => {
  const store = fakeStore();
  const controller = new AbortController();
  const asked: string[] = [];
  const result = await runGroupTurn({
    group: { id: "grp_x", name: "Desk" },
    participants: team,
    recent: [],
    message: "@everyone status",
    clientMessageId: "m5",
    signal: controller.signal,
    deps: {
      ...store.deps,
      ask: async (slug) => {
        asked.push(slug);
        controller.abort();
        throw new Error("Stopped.");
      },
    },
  });
  assert.ok(result);
  assert.deepEqual(asked, ["scout"]);
  assert.deepEqual(result.speakers.map((speaker) => speaker.status), ["stopped", "stopped", "stopped"]);
  assert.equal(result.status, "stopped");
  assert.deepEqual(store.events.filter((entry) => entry.kind === "status").map((entry) => [entry.status, entry.text]), [["stopped", "Stopped before Scout, Editor and Ops Lead replied."]]);
});

test("continuing a turn runs only the unfinished speakers with the earlier replies, and retry re-runs one", async () => {
  const store = fakeStore();
  const controller = new AbortController();
  const first = await runGroupTurn({
    group: { id: "grp_x", name: "Desk" },
    participants: team,
    recent: [event({ kind: "user", text: "Earlier hello", at: 1 })],
    message: "@everyone plan",
    clientMessageId: "m6",
    signal: controller.signal,
    deps: {
      ...store.deps,
      ask: async (slug) => {
        if (slug === "editor") {
          controller.abort();
          throw new Error("Stopped.");
        }
        return { text: "Scout's plan.", threadId: "ses_scout" };
      },
    },
  });
  assert.ok(first);
  assert.deepEqual(first.speakers.map((speaker) => speaker.status), ["succeeded", "stopped", "stopped"]);

  const asked: { slug: string; prompt: string }[] = [];
  const resumed = await resumeGroupTurn({
    group: { id: "grp_x", name: "Desk" },
    participants: team,
    turn: first,
    events: [event({ kind: "user", text: "Earlier hello", at: 1 }), ...store.events],
    signal: new AbortController().signal,
    deps: {
      ...store.deps,
      ask: async (slug, prompt) => {
        asked.push({ slug, prompt });
        if (slug === "ops") throw new Error("model unavailable");
        return { text: `${slug} continues.`, threadId: `ses_${slug}` };
      },
    },
  });
  assert.deepEqual(asked.map((entry) => entry.slug), ["editor", "ops"], "the speaker that already replied is never asked again");
  assert.match(asked[0]?.prompt ?? "", /Recent group conversation:\n- Person: Earlier hello\n/);
  assert.doesNotMatch(asked[0]?.prompt ?? "", /- Person: @everyone plan/);
  assert.match(asked[0]?.prompt ?? "", /Already said in reply to this message:\n- Scout: Scout's plan\./);
  assert.match(asked[0]?.prompt ?? "", /The person's message: @everyone plan$/);
  assert.match(asked[1]?.prompt ?? "", /- Scout: Scout's plan\.\n- Editor: editor continues\./);
  assert.deepEqual(resumed.speakers.map((speaker) => [speaker.slug, speaker.status]), [["scout", "succeeded"], ["editor", "succeeded"], ["ops", "failed"]]);
  assert.equal(resumed.status, "partial");

  const retried = await resumeGroupTurn({
    group: { id: "grp_x", name: "Desk" },
    participants: team,
    turn: resumed,
    events: store.events,
    only: "ops",
    signal: new AbortController().signal,
    deps: { ...store.deps, ask: async (slug) => ({ text: `${slug} finally.`, threadId: "ses_ops" }) },
  });
  assert.deepEqual(retried.speakers.map((speaker) => speaker.status), ["succeeded", "succeeded", "succeeded"]);
  assert.equal(retried.status, "succeeded");
  assert.equal(retried.speakers[2]?.error, "");
  assert.deepEqual(store.events.filter((entry) => entry.kind === "coworker").map((entry) => entry.slug), ["scout", "editor", "ops"]);
  // Nothing left to do: resuming a finished turn asks nobody.
  assert.equal(await resumeGroupTurn({ group: { id: "grp_x", name: "Desk" }, participants: team, turn: retried, events: store.events, signal: new AbortController().signal, deps: { ...store.deps, ask: async () => { throw new Error("must not ask"); } } }), retried);
});
