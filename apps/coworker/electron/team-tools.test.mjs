import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { TEAM_TOOL_NAMES } from "../src/lib/coworker-tools.ts";
import { createCoworker } from "./coworkers.mjs";
import { handleMcpMessage } from "./coworker-tools.mjs";
import { readReferrals, readSuggestions, setReferralState } from "./team.mjs";
import { createTeamToolHandlers, teamToolCatalog } from "./team-tools.mjs";

const roots = [];
async function tempCoworkersDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "coworker-team-tools-"));
  roots.push(dir);
  return path.join(dir, "coworkers");
}

after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const NOW = Date.UTC(2026, 8, 3, 15, 0, 0);

async function team() {
  const coworkersDir = await tempCoworkersDir();
  await createCoworker(coworkersDir, { name: "Nova", role: "Research and synthesis", mission: "I dig into questions.", roleId: "research" });
  await createCoworker(coworkersDir, { name: "Editor", role: "Writing and content", mission: "I turn rough ideas into drafts.", roleId: "writing" });
  let clock = NOW;
  const handlers = createTeamToolHandlers({ coworkersDir, now: () => clock });
  const call = (name, args, slug = "nova") =>
    handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { slug, handlers, tools: teamToolCatalog(), serverInfo: { name: "test", version: "0" } });
  return { coworkersDir, call, advance: (ms) => { clock += ms; } };
}

test("the catalog lists the three team tools with the names the renderer knows", () => {
  assert.deepEqual(teamToolCatalog().map((tool) => tool.name), [...TEAM_TOOL_NAMES]);
  for (const tool of teamToolCatalog()) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test("team_list answers with the team description and cards for everyone but the caller", async () => {
  const { call } = await team();
  const response = await call("team_list", {});
  assert.equal(response.result.isError, false);
  assert.match(response.result.content[0].text, /^# My team/);
  assert.match(response.result.content[0].text, /- Editor \(`editor`\)/);
  assert.deepEqual(response.result.structuredContent.team.map((member) => member.slug), ["editor"]);
  assert.deepEqual(Object.keys(response.result.structuredContent.team[0]).sort(), ["avatarColor", "avatarGlasses", "mission", "name", "role", "roleId", "slug"]);
});

test("team_refer offers a hand-over to a real teammate by name or id, records it, and refuses the rest in plain words", async () => {
  const { coworkersDir, call } = await team();
  const byName = await call("team_refer", { to: "editor", message: "Draft the launch announcement", why: "Editor writes for a living." });
  assert.equal(byName.result.isError, false);
  assert.equal(byName.result.content[0].text, "Offered to pass this to Editor. Reply with one short sentence and stop — the person chooses.");
  const referral = byName.result.structuredContent.referral;
  assert.match(referral.id, /^ref_/);
  assert.equal(referral.to.slug, "editor");
  assert.equal(referral.to.name, "Editor");
  assert.equal(referral.message, "Draft the launch announcement");
  assert.equal(referral.why, "Editor writes for a living.");

  const byCasedName = await call("team_refer", { to: "EDITOR", message: "x", why: "y" });
  assert.equal(byCasedName.result.structuredContent.referral.to.slug, "editor");
  assert.equal((await readReferrals(coworkersDir, "nova")).length, 2, "each offer is on record for the view");

  const unknown = await call("team_refer", { to: "Care", message: "Watch the inbox", why: "support" });
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.content[0].text, /^Couldn't offer to pass this on: Nobody on the team is called "Care"/);
  const self = await call("team_refer", { to: "Nova", message: "Research this", why: "research" });
  assert.match(self.result.content[0].text, /That is you\. Do the work yourself/);
  const missing = await call("team_refer", { to: "editor", message: "", why: "y" });
  assert.match(missing.result.content[0].text, /Include the person's request in their own words/);
});

test("team_refer does not offer a request again once the person chose to keep it with the coworker", async () => {
  const { coworkersDir, call } = await team();
  const first = await call("team_refer", { to: "editor", message: "Draft the launch announcement", why: "Editor writes for a living." });
  assert.equal(first.result.isError, false);
  await setReferralState(coworkersDir, "nova", first.result.structuredContent.referral.id, "continued", { now: NOW + 60_000 });
  const again = await call("team_refer", { to: "editor", message: "draft the launch announcement", why: "Editor writes for a living." });
  assert.equal(again.result.isError, false, "a kept request is a check, not a failure");
  assert.equal(again.result.content[0].text, "The person already asked you to keep this yourself. Do the work now and don't offer to pass it on again.");
  assert.deepEqual(again.result.structuredContent, { kept: { at: NOW + 60_000 } });
  assert.equal((await readReferrals(coworkersDir, "nova")).length, 1, "nothing new is recorded");
  const other = await call("team_refer", { to: "editor", message: "Rewrite the pricing page", why: "Editor writes for a living." });
  assert.equal(other.result.isError, false);
  assert.ok(other.result.structuredContent.referral, "a different request may still be offered");
});

test("team_suggest proposes a teammate once, then defers to the guards: existing, declined, daily", async () => {
  const { coworkersDir, call, advance } = await team();
  const first = await call("team_suggest", { role: "support", mission: "I watch the inbox and answer with care.", why: "The support inbox comes up every morning." });
  assert.equal(first.result.isError, false);
  assert.equal(first.result.content[0].text, "Suggested Care for customer support. Reply with one short sentence and stop — the person decides whether to add them.");
  const suggestion = first.result.structuredContent.suggestion;
  assert.match(suggestion.id, /^sug_/);
  assert.equal(suggestion.by, "nova");
  assert.equal(suggestion.roleId, "support");
  assert.equal(suggestion.role, "Customer support");
  assert.equal(suggestion.name, "Care");
  assert.equal(suggestion.mission, "I watch the inbox and answer with care.");
  assert.equal(suggestion.avatarColor, "rose");
  assert.equal(suggestion.avatarGlasses, "none");
  assert.equal(suggestion.personality, "warm");

  // Already covered by a teammate: no card, a nudge to refer instead.
  const covered = await call("team_suggest", { role: "writing", mission: "I write.", why: "The person asked for a writer." });
  assert.equal(covered.result.isError, false);
  assert.equal(covered.result.content[0].text, "Editor already covers writing and content. Offer to pass it to them with coworker_team_refer instead.");
  assert.equal(covered.result.structuredContent.existing.slug, "editor");
  assert.equal(covered.result.structuredContent.suggestion, undefined);
  // The caller's own job is not a teammate to propose.
  const own = await call("team_suggest", { role: "research", mission: "I research.", why: "Research came up." });
  assert.match(own.result.content[0].text, /^That is your own job/);
  assert.equal(own.result.structuredContent.self, true);

  // One a day: a second proposal the same day is turned down without a card.
  const second = await call("team_suggest", { role: "sales", mission: "I keep leads warm.", why: "Leads keep coming up." });
  assert.equal(second.result.content[0].text, "You already suggested a teammate today. Answer the request as best you can.");
  assert.equal(second.result.structuredContent.limit, "daily");
  assert.equal((await readSuggestions(coworkersDir, "nova")).length, 1, "a refused proposal is not recorded");

  // The next day a fresh proposal goes through; a free-text role gets a name from its words and a neutral look.
  advance(86_400_000);
  const planner = await call("team_suggest", { role: "event planner", mission: "I plan the offsites.", why: "Two offsites are coming up.", name: "" });
  assert.equal(planner.result.isError, false);
  assert.equal(planner.result.structuredContent.suggestion.name, "Event");
  assert.equal(planner.result.structuredContent.suggestion.role, "Event Planner");
  assert.equal(planner.result.structuredContent.suggestion.roleId, "");
  assert.equal(planner.result.structuredContent.suggestion.personality, "neutral");
  assert.match(planner.result.content[0].text, /^Suggested Event for event planner\./);

  // A name the model proposes is kept when it is free; a taken one falls back to the catalog.
  advance(86_400_000);
  const named = await call("team_suggest", { role: "sales", mission: "I keep leads warm.", why: "Leads.", name: "Editor" });
  assert.equal(named.result.structuredContent.suggestion.name, "Pipeline");
  advance(86_400_000);
  const free = await call("team_suggest", { role: "product", mission: "I ship.", why: "Bugs.", name: "Kit" });
  assert.equal(free.result.structuredContent.suggestion.name, "Kit");

  const missing = await call("team_suggest", { role: "", mission: "x", why: "y" });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /^Couldn't suggest a teammate: Say what role/);
});
