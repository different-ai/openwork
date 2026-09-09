import assert from "node:assert/strict";
import test from "node:test";
import type { CoworkerGroupTurn } from "./bridge.ts";
import {
  earlierSpeakerOrders,
  extractJson,
  facilitatorModels,
  routeWithFacilitator,
  validateRoutingPlan,
} from "./facilitator.ts";
import type { EngineModelOption } from "./threads.ts";

const scout = { slug: "scout", name: "Scout", role: "Research partner", mission: "Find and check sources for the team." };
const editor = { slug: "editor", name: "Editor", role: "Writing partner", mission: "Shape drafts into clear writing." };
const ops = { slug: "ops", name: "Ops Lead", role: "", mission: "" };
const team = [scout, editor, ops];
const nobody = { everyone: false, slugs: [] };

function model(id: string, extra: Partial<EngineModelOption> = {}): EngineModelOption {
  const [providerId = "", modelId = ""] = id.split("/");
  return { id, providerId, providerLabel: providerId, modelId, modelLabel: modelId, label: id, description: "", family: "", variants: [], isProviderDefault: false, source: "local", tier: "key", toolCall: true, reasoning: false, status: "active", releaseDate: "2026-01-01", cost: { input: 0, output: 0 }, ...extra };
}

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
    synthesizer: null,
    routedBy: "facilitator",
  });
  assert.throws(() => validateRoutingPlan({ speakers: [] }, { participants: team, mentions: nobody }), /did not match the shape/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "nova" }] }, { participants: team, mentions: nobody }), /not members of the group: nova/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }, { slug: "scout" }] }, { participants: team, mentions: nobody }), /listed twice/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }, { slug: "editor" }, { slug: "ops" }, { slug: "care" }] }, { participants: [...team, { ...ops, slug: "care", name: "Care" }], mentions: nobody }), /at most 3/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }] }, { participants: team, mentions: { everyone: true, slugs: [] } }), /every invited member must speak/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }] }, { participants: team, mentions: { everyone: false, slugs: ["editor"] } }), /addressed coworkers are editor/);
  assert.deepEqual(validateRoutingPlan({ speakers: [{ slug: "editor" }, { slug: "scout" }] }, { participants: team, mentions: { everyone: false, slugs: ["scout", "editor"] } }).speakers.map((speaker) => speaker.slug), ["editor", "scout"], "several mentions keep the set and let the facilitator order");
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }, { slug: "editor" }], dependsOn: [["scout", "editor"]] }, { participants: team, mentions: nobody }), /earlier speaker must come before/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }], dependsOn: [["scout", "ops"]] }, { participants: team, mentions: nobody }), /not among the speakers/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }], followUp: { slug: "nova" } }, { participants: team, mentions: nobody }), /followUp names nova/);
  assert.throws(() => validateRoutingPlan({ speakers: [{ slug: "scout" }], synthesizer: "nova" }, { participants: team, mentions: nobody }), /synthesizer names nova/);
  const largerTeam = [...team, { ...ops, slug: "care", name: "Care" }];
  const addressedSlugs = largerTeam.map((member) => member.slug);
  assert.equal(validateRoutingPlan({ addressedSlugs, speakers: addressedSlugs.map((slug) => ({ slug })), mode: "parallel" }, { participants: largerTeam, mentions: nobody }).speakers.length, 4, "a semantic collective audience is not capped at three");
  assert.throws(() => validateRoutingPlan({ addressedSlugs, speakers: [{ slug: "scout" }] }, { participants: largerTeam, mentions: nobody }), /every invited member must speak/, "one response cannot satisfy the collective audience");
  assert.throws(() => validateRoutingPlan({ addressedSlugs: ["stranger"], speakers: [{ slug: "scout" }] }, { participants: team, mentions: nobody }), /known members/);
  const exceptScout = { addressedSlugs: ["editor", "ops"], speakers: [{ slug: "editor" }, { slug: "ops" }] };
  assert.deepEqual(validateRoutingPlan(exceptScout, { participants: team, mentions: { everyone: true, slugs: ["scout"] } }).speakers.map((speaker) => speaker.slug), ["editor", "ops"], "an interpreted exclusion overrides the literal @everyone hint");
  assert.throws(() => validateRoutingPlan({ ...exceptScout, followUp: { slug: "scout" } }, { participants: team, mentions: nobody }), /addressed audience/);
  assert.throws(() => validateRoutingPlan({ ...exceptScout, synthesizer: "scout" }, { participants: team, mentions: nobody }), /addressed audience/);
  assert.throws(() => validateRoutingPlan({ addressedSlugs: ["editor"], speakers: [{ slug: "editor" }, { slug: "scout" }] }, { participants: team, mentions: nobody }), /nobody else/, "a semantic single addressee cannot expand to the team");
  assert.deepEqual(extractJson('Sure.\n```json\n{"speakers":[{"slug":"scout"}]}\n```'), { speakers: [{ slug: "scout" }] });
  assert.throws(() => extractJson("I would pick Scout."), /no JSON object/);
  assert.throws(() => extractJson("{not json}"), /not valid JSON/);
});

test("the facilitator's model is the one the coworkers use, account models first, with a distinct second choice", () => {
  const catalog = { models: [model("openai/gpt", { source: "local" }), model("lpr_a/claude", { source: "cloud", isProviderDefault: true }), model("openai/mini", { source: "local" })] };
  const members = [{ model: "openai/gpt" }, { model: "lpr_a/claude" }, { model: "" }];
  assert.deepEqual(Object.values(facilitatorModels(catalog, members)).map((item) => item?.id), ["lpr_a/claude", "openai/gpt"]);
  assert.deepEqual(Object.values(facilitatorModels(catalog, members, "openai/mini")).map((item) => item?.id), ["openai/mini", "lpr_a/claude"]);
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

  // Repaired on the same model after one rejection that names the problem.
  let plan = await routeWithFacilitator({ prompt: "P", participants: team, mentions: nobody, models: { primary, secondary }, signal: new AbortController().signal, ask: async (prompt, used) => { asked.push(`${used.id}:${prompt.slice(0, 16)}`); return asked.length === 1 ? '{"speakers":[{"slug":"nova"}]}' : good; }, onAttempt: (detail) => attempts.push(`${detail.model}=${detail.outcome}`) });
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
  asked.length = 0;
  const unexpectedAsk: NonNullable<Parameters<typeof routeWithFacilitator>[0]["ask"]> = async (_prompt, used) => { asked.push(used.id); return good; };
  assert.equal(await routeWithFacilitator({ prompt: "P", participants: team, mentions: nobody, models: { primary: null, secondary: null }, signal: new AbortController().signal, ask: unexpectedAsk }), null);
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(await routeWithFacilitator({ prompt: "P", participants: team, mentions: nobody, models: { primary, secondary }, signal: stopped.signal, ask: unexpectedAsk }), null);
  assert.deepEqual(asked, [], "missing models and stopped turns never ask");
});
