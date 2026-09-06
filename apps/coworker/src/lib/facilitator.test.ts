import assert from "node:assert/strict";
import test from "node:test";
import type { CoworkerGroupTurn, GroupTimelineEvent } from "./bridge.ts";
import {
  earlierSpeakerOrders,
  extractJson,
  facilitatorModels,
  facilitatorPrompt,
  repairPrompt,
  routeWithFacilitator,
  validateRoutingPlan,
} from "./facilitator.ts";
import type { EngineModelOption } from "./threads.ts";

const scout = { slug: "scout", name: "Scout", role: "Research partner", mission: "Find and check sources for the team." };
const editor = { slug: "editor", name: "Editor", role: "Writing partner", mission: "Shape drafts into clear writing." };
const ops = { slug: "ops", name: "Ops Lead", role: "", mission: "" };
const team = [scout, editor, ops];
const nobody = { everyone: false, slugs: [] };

function event(partial: Partial<GroupTimelineEvent> & Pick<GroupTimelineEvent, "kind" | "text">): GroupTimelineEvent {
  return { id: `evt_${Math.random().toString(36).slice(2)}`, at: 1, ...partial };
}

function model(id: string, extra: Partial<EngineModelOption> = {}): EngineModelOption {
  const [providerId = "", modelId = ""] = id.split("/");
  return { id, providerId, providerLabel: providerId, modelId, modelLabel: modelId, label: id, description: "", family: "", variants: [], isProviderDefault: false, source: "local", tier: "key", toolCall: true, reasoning: false, status: "active", releaseDate: "2026-01-01", cost: { input: 0, output: 0 }, ...extra };
}

test("the facilitator is told the room, availability, the bounded conversation, earlier orders, the message, and the mention constraint", () => {
  const prompt = facilitatorPrompt({
    group: { name: "Desk" },
    members: [{ ...scout, busy: false }, { ...editor, busy: true }, { ...ops, busy: false }],
    recent: [event({ kind: "user", text: "Hello" }), event({ kind: "status", text: "Scout could not reply" }), event({ kind: "coworker", slug: "scout", text: "Hi" })],
    earlierOrders: [["scout"], ["editor", "scout"]],
    message: "Plan the launch note",
    mentions: nobody,
    nameFor: (slug) => (slug === "scout" ? "Scout" : slug),
  });
  assert.match(prompt, /^You are the facilitator of the group chat "Desk"/);
  assert.match(prompt, /- scout — Scout, Research partner\. Mission: Find and check sources for the team\. \(available\)/);
  assert.match(prompt, /- editor — Editor, Writing partner\. Mission: Shape drafts into clear writing\. \(busy replying in another group\)/);
  assert.match(prompt, /- ops — Ops Lead\. \(available\)/);
  assert.match(prompt, /Recent conversation, oldest first:\n- Person: Hello\n- Scout: Hi/);
  assert.doesNotMatch(prompt, /could not reply/);
  assert.match(prompt, /answered in this order: scout; editor → scout\./);
  assert.match(prompt, /The person's message: Plan the launch note\nConstraint: nobody was named\. Choose one coworker/);
  assert.match(prompt, /Reply with one JSON object only/);
  assert.match(facilitatorPrompt({ group: { name: "D" }, members: [{ ...scout, busy: false }, { ...editor, busy: false }], recent: [], earlierOrders: [], message: "x", mentions: { everyone: true, slugs: [] }, nameFor: (slug) => slug }), /Constraint: the person asked everyone\. Include every member \(scout, editor\) exactly once/);
  assert.match(facilitatorPrompt({ group: { name: "D" }, members: [{ ...scout, busy: false }], recent: [], earlierOrders: [], message: "x", mentions: { everyone: false, slugs: ["scout"] }, nameFor: (slug) => slug }), /Constraint: the person named scout\. The speakers must be exactly that one coworker\./);
  assert.match(facilitatorPrompt({ group: { name: "D" }, members: [{ ...scout, busy: false }], recent: [], earlierOrders: [], message: "x", mentions: { everyone: false, slugs: ["scout", "editor"] }, nameFor: (slug) => slug }), /Constraint: the person named scout, editor\. The speakers must be exactly these coworkers/);
  assert.match(repairPrompt("a coworker was listed twice."), /^Your last answer was not accepted: a coworker was listed twice\. Reply again with one JSON object only/);
});

test("earlier speaker orders come from the recorded turns, replies only", () => {
  const turn = (speakers: Array<[string, CoworkerGroupTurn["speakers"][number]["part"]]>): CoworkerGroupTurn => ({
    id: "t", clientMessageId: "m", prompt: "p", createdAt: 1, updatedAt: 1, status: "succeeded", mode: "sequential", routedBy: "facilitator",
    speakers: speakers.map(([slug, part], order) => ({ slug, order, status: "succeeded", part, brief: "", threadId: "", error: "", startedAt: null, endedAt: null })),
  });
  assert.deepEqual(earlierSpeakerOrders([turn([["scout", "reply"]]), turn([]), turn([["editor", "reply"], ["scout", "reply"], ["editor", "wrap-up"]])]), [["scout"], ["editor", "scout"]]);
  assert.deepEqual(earlierSpeakerOrders(Array.from({ length: 8 }, (_, index) => turn([[index % 2 ? "scout" : "editor", "reply"]]))).length, 5);
});

test("a facilitator answer is accepted only when it names known members once, honours mentions, and orders dependencies", () => {
  const plan = validateRoutingPlan({ speakers: [{ slug: "Editor", brief: " Say what the note promises. " }, { slug: "scout" }], mode: "parallel", dependsOn: [["scout", "editor"]], followUp: { slug: "editor", brief: "Fold in the sources." }, synthesizer: "ops" }, { participants: team, mentions: nobody });
  assert.deepEqual(plan, {
    speakers: [{ slug: "editor", brief: "Say what the note promises." }, { slug: "scout", brief: "" }],
    mode: "sequential",
    dependsOn: [["scout", "editor"]],
    followUp: { slug: "editor", brief: "Fold in the sources." },
    synthesizer: "ops",
    routedBy: "facilitator",
  });
  assert.equal(validateRoutingPlan({ speakers: [{ slug: "scout" }], mode: "parallel" }, { participants: team, mentions: nobody }).mode, "parallel");
  assert.throws(() => validateRoutingPlan({ speakers: [] }, { participants: team, mentions: nobody }), /did not match the shape/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "nova" }] }, { participants: team, mentions: nobody }), /not members of the group: nova/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }, { slug: "scout" }] }, { participants: team, mentions: nobody }), /listed twice/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }, { slug: "editor" }, { slug: "ops" }, { slug: "scout" }] }, { participants: [...team, { ...ops, slug: "care", name: "Care" }], mentions: nobody }), /listed twice/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }, { slug: "editor" }, { slug: "ops" }, { slug: "care" }] }, { participants: [...team, { ...ops, slug: "care", name: "Care" }], mentions: nobody }), /at most 3/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }] }, { participants: team, mentions: { everyone: true, slugs: [] } }), /every member must speak/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }] }, { participants: team, mentions: { everyone: false, slugs: ["editor"] } }), /named editor, so the speakers must be exactly those/);
  assert.deepEqual(validateRoutingPlan({ speakers: [{ slug: "editor" }, { slug: "scout" }] }, { participants: team, mentions: { everyone: false, slugs: ["scout", "editor"] } }).speakers.map((speaker) => speaker.slug), ["editor", "scout"], "several mentions keep the set and let the facilitator order");
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }, { slug: "editor" }], dependsOn: [["scout", "editor"]] }, { participants: team, mentions: nobody }), /earlier speaker must come before/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }], dependsOn: [["scout", "ops"]] }, { participants: team, mentions: nobody }), /not among the speakers/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }], followUp: { slug: "nova" } }, { participants: team, mentions: nobody }), /followUp names nova/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }], synthesizer: "nova" }, { participants: team, mentions: nobody }), /synthesizer names nova/);
  assert.deepEqual(extractJson('Sure.\n```json\n{"speakers":[{"slug":"scout"}]}\n```'), { speakers: [{ slug: "scout" }] });
  assert.throws(() => extractJson("I would pick Scout."), /no JSON object/);
  assert.throws(() => extractJson("{not json}"), /not valid JSON/);
});

test("the facilitator's model is the one the coworkers use, account models first, with a distinct second choice", () => {
  const catalog = { models: [model("openai/gpt", { source: "local" }), model("lpr_a/claude", { source: "cloud", isProviderDefault: true }), model("openai/mini", { source: "local" })] };
  const members = [{ model: "openai/gpt" }, { model: "lpr_a/claude" }, { model: "" }];
  assert.deepEqual(Object.values(facilitatorModels(catalog, members)).map((item) => item?.id), ["lpr_a/claude", "openai/gpt"]);
  assert.deepEqual(Object.values(facilitatorModels(catalog, members, "openai/mini")).map((item) => item?.id), ["openai/mini", "lpr_a/claude"]);
  // Nobody chose a model: the recommended one, then the next.
  assert.deepEqual(Object.values(facilitatorModels(catalog, [{ model: "" }])).map((item) => item?.id), ["lpr_a/claude", "openai/gpt"]);
  // A saved model that is not connected any more is skipped rather than chosen blindly.
  assert.deepEqual(Object.values(facilitatorModels(catalog, [{ model: "gone/model" }], "gone/other")).map((item) => item?.id), ["lpr_a/claude", "openai/gpt"]);
  assert.deepEqual(facilitatorModels({ models: [] }, members), { primary: null, secondary: null });
});

test("a routing pass repairs once, then tries the next model once, then gives up quietly", async () => {
  const primary = model("a/one");
  const secondary = model("b/two");
  const asked: string[] = [];
  const attempts: string[] = [];
  const good = '{"speakers":[{"slug":"scout","brief":"Sources."}],"mode":"sequential","dependsOn":[],"followUp":null,"synthesizer":null}';

  // Accepted on the first answer.
  let plan = await routeWithFacilitator({ prompt: "P", participants: team, mentions: nobody, models: { primary, secondary }, signal: new AbortController().signal, ask: async (prompt, used) => { asked.push(`${used.id}:${prompt.slice(0, 4)}`); return good; }, onAttempt: (detail) => attempts.push(`${detail.model}=${detail.outcome}`) });
  assert.equal(plan?.speakers[0]?.slug, "scout");
  assert.deepEqual(asked, ["a/one:P"]);
  assert.deepEqual(attempts, ["a/one=accepted"]);

  // Repaired on the same model after one rejection that names the problem.
  asked.length = 0;
  attempts.length = 0;
  plan = await routeWithFacilitator({ prompt: "P", participants: team, mentions: nobody, models: { primary, secondary }, signal: new AbortController().signal, ask: async (prompt, used) => { asked.push(`${used.id}:${prompt.slice(0, 16)}`); return asked.length === 1 ? '{"speakers":[{"slug":"nova"}]}' : good; }, onAttempt: (detail) => attempts.push(`${detail.model}=${detail.outcome}`) });
  assert.equal(plan?.routedBy, "facilitator");
  assert.deepEqual(asked, ["a/one:P", "a/one:Your last answer"]);
  assert.deepEqual(attempts, ["a/one=repaired"]);

  // The first model is unavailable: the second decides.
  asked.length = 0;
  attempts.length = 0;
  plan = await routeWithFacilitator({ prompt: "P", participants: team, mentions: nobody, models: { primary, secondary }, signal: new AbortController().signal, ask: async (_prompt, used) => { asked.push(used.id); if (used.id === "a/one") throw new Error("model unavailable"); return good; }, onAttempt: (detail) => attempts.push(`${detail.model}=${detail.outcome}`) });
  assert.equal(plan?.speakers.length, 1);
  assert.deepEqual(asked, ["a/one", "b/two"]);
  assert.deepEqual(attempts, ["a/one=failed", "b/two=accepted"]);

  // Both keep answering badly: null, so the scorer decides.
  asked.length = 0;
  plan = await routeWithFacilitator({ prompt: "P", participants: team, mentions: nobody, models: { primary, secondary }, signal: new AbortController().signal, ask: async (_prompt, used) => { asked.push(used.id); return "I would pick Scout."; } });
  assert.equal(plan, null);
  assert.deepEqual(asked, ["a/one", "a/one", "b/two", "b/two"]);
  // No model at all, or a stopped turn: nobody is asked.
  assert.equal(await routeWithFacilitator({ prompt: "P", participants: team, mentions: nobody, models: { primary: null, secondary: null }, signal: new AbortController().signal, ask: async () => { throw new Error("must not ask"); } }), null);
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(await routeWithFacilitator({ prompt: "P", participants: team, mentions: nobody, models: { primary, secondary }, signal: stopped.signal, ask: async () => { throw new Error("must not ask"); } }), null);
});
