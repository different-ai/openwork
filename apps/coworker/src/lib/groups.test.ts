import assert from "node:assert/strict";
import test from "node:test";
import type { GroupTimelineEvent } from "./bridge.ts";
import {
  chooseSpeakers,
  describeGroupActivity,
  groupSpeakerPrompt,
  parseMentions,
  replyTextSince,
  runGroupTurn,
  suggestGroupName,
} from "./groups.ts";

const scout = { slug: "scout", name: "Scout", role: "Research partner", mission: "Find and check sources for the team." };
const editor = { slug: "editor", name: "Editor", role: "Writing partner", mission: "Shape drafts into clear writing." };
const ops = { slug: "ops", name: "Ops Lead", role: "", mission: "" };
const team = [scout, editor, ops];

function event(partial: Partial<GroupTimelineEvent> & Pick<GroupTimelineEvent, "kind" | "text">): GroupTimelineEvent {
  return { id: `evt_${Math.random().toString(36).slice(2)}`, at: 1, ...partial };
}

test("mentions name coworkers by handle or first name, once each, and @everyone includes all", () => {
  assert.deepEqual(parseMentions("@Editor and @scout, then @editor again", team), { everyone: false, slugs: ["editor", "scout"] });
  assert.deepEqual(parseMentions("@ops what do you think", team), { everyone: false, slugs: ["ops"] });
  assert.deepEqual(parseMentions("email me at me@example.com", team), { everyone: false, slugs: [] });
  assert.deepEqual(parseMentions("@everyone weigh in", team), { everyone: true, slugs: [] });
});

test("the facilitator picks one coworker by role and mission unless the message names who answers", () => {
  assert.deepEqual(chooseSpeakers("Can you check the sources in this research?", team), ["scout"]);
  assert.deepEqual(chooseSpeakers("Tighten the writing in this draft", team), ["editor"]);
  assert.deepEqual(chooseSpeakers("@Editor @scout both look at this", team), ["editor", "scout"]);
  assert.deepEqual(chooseSpeakers("@everyone quick thoughts", team), ["scout", "editor", "ops"]);
  // With no signal at all, the coworker who spoke last keeps the floor; a fresh group falls to the first member.
  assert.deepEqual(chooseSpeakers("thanks, go on", team, [event({ kind: "coworker", slug: "editor", text: "Here is a draft." })]), ["editor"]);
  assert.deepEqual(chooseSpeakers("thanks, go on", team), ["scout"]);
  assert.deepEqual(chooseSpeakers("anything", []), []);
});

test("a group name comes from roles when they exist, otherwise from names", () => {
  assert.equal(suggestGroupName([scout, editor]), "Research & Writing");
  assert.equal(suggestGroupName([scout, editor, ops]), "Research & Writing");
  assert.equal(suggestGroupName([ops, { ...ops, slug: "care", name: "Care" }]), "Ops Lead & Care");
  assert.equal(suggestGroupName([{ ...scout, role: "Research" }, { ...editor, role: "Research" }]), "Research desk");
});

test("a speaker's prompt carries the room, the recent visible conversation, earlier replies, and the message only", () => {
  const prompt = groupSpeakerPrompt({
    group: { name: "Desk" },
    speaker: editor,
    participants: [scout, editor],
    message: "What should the intro say?",
    recent: [
      event({ kind: "user", text: "Hello both" }),
      event({ kind: "status", text: "Scout could not reply: offline" }),
      event({ kind: "coworker", slug: "scout", text: "Hi from Scout" }),
    ],
    earlierReplies: [{ name: "Scout", text: "Lead with the finding." }],
    nameFor: (slug) => (slug === "scout" ? "Scout" : slug),
  });
  assert.match(prompt, /^You are Editor, Writing partner, in the group chat "Desk" with the person and Scout \(Research partner\)\./);
  assert.match(prompt, /- Person: Hello both\n- Scout: Hi from Scout/);
  assert.doesNotMatch(prompt, /could not reply/);
  assert.match(prompt, /Already said in reply to this message:\n- Scout: Lead with the finding\./);
  assert.match(prompt, /The person's message: What should the intro say\?$/);
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
});

test("describeGroupActivity names the latest speaker in plain words", () => {
  assert.equal(describeGroupActivity([], () => "x"), "No messages yet");
  assert.equal(describeGroupActivity([event({ kind: "user", text: "hi" })], () => "x"), "Waiting for a reply");
  assert.equal(describeGroupActivity([event({ kind: "user", text: "hi" }), event({ kind: "coworker", slug: "scout", text: "hey" }), event({ kind: "status", text: "s" })], (slug) => slug.toUpperCase()), "SCOUT replied");
});

test("a group turn records the message, asks each chosen speaker in order with earlier replies, and keeps going past one failure", async () => {
  const appended: Omit<GroupTimelineEvent, "id" | "at">[] = [];
  const asked: { slug: string; prompt: string }[] = [];
  const progress: string[] = [];
  const result = await runGroupTurn({
    group: { id: "grp_x", name: "Desk" },
    participants: team,
    recent: [],
    message: "@scout @editor @ops plan the launch note",
    clientMessageId: "m1",
    signal: new AbortController().signal,
    deps: {
      append: async (input) => {
        appended.push(input);
        return { id: `evt_${appended.length}`, at: appended.length, ...input };
      },
      ask: async (slug, prompt) => {
        asked.push({ slug, prompt });
        if (slug === "editor") throw new Error("model unavailable");
        return slug === "scout" ? "Sources are ready." : "Ops can ship Friday.";
      },
      onProgress: (state) => progress.push(`${state.phase}:${state.speakers.map((speaker) => `${speaker.slug}=${speaker.status}`).join(",")}`),
    },
  });
  assert.deepEqual(asked.map((entry) => entry.slug), ["scout", "editor", "ops"]);
  const [firstAsk, , thirdAsk] = asked;
  if (!firstAsk || !thirdAsk) throw new Error("Expected three speakers to be asked.");
  assert.doesNotMatch(firstAsk.prompt, /Already said/);
  assert.match(thirdAsk.prompt, /Already said in reply to this message:\n- Scout: Sources are ready\./);
  // The message being answered appears once, at the end, not again as recent conversation.
  assert.doesNotMatch(thirdAsk.prompt, /- Person: @scout @editor @ops plan the launch note/);
  assert.match(thirdAsk.prompt, /The person's message: @scout @editor @ops plan the launch note$/);
  assert.deepEqual(appended.map((entry) => [entry.kind, entry.slug ?? "", entry.status ?? ""]), [
    ["user", "", ""],
    ["coworker", "scout", ""],
    ["status", "editor", "failed"],
    ["coworker", "ops", ""],
  ]);
  assert.equal(appended[2]?.text, "Editor could not reply: model unavailable");
  assert.deepEqual(result.speakers.map((speaker) => speaker.status), ["succeeded", "failed", "succeeded"]);
  assert.equal(progress[0], "routing:");
  assert.equal(progress.at(-1), "done:scout=succeeded,editor=failed,ops=succeeded");
});

test("stopping a group turn marks the remaining speakers stopped without asking them", async () => {
  const controller = new AbortController();
  const asked: string[] = [];
  const result = await runGroupTurn({
    group: { id: "grp_x", name: "Desk" },
    participants: team,
    recent: [],
    message: "@everyone status",
    clientMessageId: "m2",
    signal: controller.signal,
    deps: {
      append: async (input) => ({ id: "evt", at: 1, ...input }),
      ask: async (slug) => {
        asked.push(slug);
        controller.abort();
        return "Done.";
      },
    },
  });
  assert.deepEqual(asked, ["scout"]);
  assert.deepEqual(result.speakers.map((speaker) => speaker.status), ["succeeded", "stopped", "stopped"]);
});
