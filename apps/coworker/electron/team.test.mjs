import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createCoworker } from "./coworkers.mjs";
import {
  DECLINE_QUIET_DAYS,
  foldLog,
  readReferrals,
  readSuggestions,
  recordReferral,
  recordSuggestion,
  rosterFor,
  setReferralState,
  setSuggestionState,
  suggestionGuard,
  teamStates,
  writeTeamRoster,
} from "./team.mjs";

const roots = [];
async function tempCoworkersDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "coworker-team-"));
  roots.push(dir);
  return path.join(dir, "coworkers");
}

after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 3, 15, 0, 0);

const TEAM = [
  { slug: "nova", name: "Nova", role: "Research and synthesis", mission: "I dig into questions.", roleId: "research" },
  { slug: "editor", name: "Editor", role: "Writing and content", mission: "I turn rough ideas into clear drafts.", roleId: "writing" },
  { slug: "pat", name: "Pat", role: "Bookkeeper", mission: "I reconcile invoices and expenses every week.", roleId: "" },
];

test("rosterFor names teammates one line each, caps the list, lists recent declines, and never repeats the coworker itself", () => {
  const self = { slug: "nova", name: "Nova", role: "Research and synthesis", mission: "I dig into questions." };
  const alone = rosterFor(self, [self], [], { now: NOW });
  assert.match(alone, /^# My team\n/);
  assert.match(alone, /I am Nova \(Research and synthesis\)\./);
  assert.match(alone, /No teammates yet — I am the only coworker\./);
  // The facts only: when to refer or suggest is the contract's rule, said once there, not repeated here.
  assert.doesNotMatch(alone, /coworker_team_refer|coworker_team_suggest|never edit it/);

  const roster = rosterFor(self, TEAM, [
    { id: "s1", roleId: "support", role: "support", state: "declined", at: NOW - 2 * DAY },
    { id: "s2", roleId: "sales", role: "sales", state: "declined", at: NOW - (DECLINE_QUIET_DAYS + 1) * DAY },
    { id: "s3", roleId: "product", role: "product", state: "accepted", at: NOW - DAY },
  ], { now: NOW });
  assert.match(roster, /- Editor \(`editor`\) — Writing and content — I turn rough ideas into clear drafts\./);
  assert.match(roster, /- Pat \(`pat`\) — Bookkeeper — I reconcile invoices and expenses every week\./);
  assert.doesNotMatch(roster, /- Nova \(`nova`\)/);
  assert.match(roster, /## Recently declined/);
  assert.match(roster, /- a customer support coworker — Sep 1/);
  assert.doesNotMatch(roster, /sales and relationships coworker/, "an old decline has expired");
  assert.doesNotMatch(roster, /product and engineering coworker/, "an accepted suggestion is not a decline");

  const many = Array.from({ length: 15 }, (_, index) => ({ slug: `c${index}`, name: `Coworker ${String(index).padStart(2, "0")}`, role: "Role", mission: "x".repeat(300) }));
  const capped = rosterFor(self, [self, ...many], [], { now: NOW });
  assert.equal(capped.match(/^- Coworker /gm)?.length, 12);
  assert.match(capped, /- and 3 more/);
  assert.match(capped, /x{139}…/, "a long mission is cut");
});

test("logs fold by id, latest state wins, and states survive a torn line", () => {
  const folded = foldLog([
    { id: "a", at: 1, state: "offered", role: "support" },
    { id: "b", at: 2, state: "offered", role: "sales" },
    { id: "a", at: 3, state: "declined" },
    { id: "b", at: 4, state: "accepted", createdSlug: "pipeline" },
    { at: 5, state: "orphan" },
  ]);
  assert.deepEqual(folded.map((entry) => [entry.id, entry.state, entry.stateAt, entry.createdSlug ?? "", entry.at]), [["a", "declined", 3, "", 1], ["b", "accepted", 4, "pipeline", 2]]);
});

test("suggestionGuard: an existing teammate first, then a recent decline, then the daily limit", () => {
  const suggestions = [
    { id: "s1", at: NOW - 3 * DAY, roleId: "support", role: "support", state: "declined", stateAt: NOW - 3 * DAY },
    { id: "s2", at: NOW - 20 * DAY, roleId: "sales", role: "sales", state: "declined", stateAt: NOW - 20 * DAY },
  ];
  assert.deepEqual(suggestionGuard({ role: "writing", team: TEAM, suggestions, now: NOW }).kind, "existing");
  assert.deepEqual(suggestionGuard({ role: "support", team: TEAM, suggestions, now: NOW }), { kind: "declined", at: NOW - 3 * DAY });
  assert.equal(suggestionGuard({ role: "sales", team: TEAM, suggestions, now: NOW }).kind, "ok", "an old decline has expired");
  assert.equal(suggestionGuard({ role: "product", team: TEAM, suggestions: [...suggestions, { id: "s3", at: NOW - 3_600_000, roleId: "sales", role: "sales", state: "offered", stateAt: NOW - 3_600_000 }], now: NOW }).kind, "daily");
  // A free-text role is matched by its words for the decline check.
  const freeText = [{ id: "s4", at: NOW - DAY, roleId: "", role: "Event planner", state: "declined", stateAt: NOW - DAY }];
  assert.equal(suggestionGuard({ role: "event planner", team: TEAM, suggestions: freeText, now: NOW }).kind, "declined");
  assert.equal(suggestionGuard({ role: "gardener", team: TEAM, suggestions: freeText, now: NOW }).kind, "ok");
});

test("suggestions and referrals are recorded, answered, and read back for the view", async () => {
  const coworkersDir = await tempCoworkersDir();
  const nova = await createCoworker(coworkersDir, { name: "Nova", role: "Research", roleId: "research" });
  const editor = await createCoworker(coworkersDir, { name: "Editor", role: "Writing", roleId: "writing" });

  const suggestion = await recordSuggestion(coworkersDir, "nova", { roleId: "support", role: "Customer support", name: "Care", mission: "I watch the inbox.", why: "the inbox comes up every morning" }, { now: NOW });
  assert.match(suggestion.id, /^sug_[a-f0-9]{20}$/);
  assert.equal(suggestion.state, "offered");
  assert.equal(suggestion.by, "nova");
  const declined = await setSuggestionState(coworkersDir, "nova", suggestion.id, "declined", { now: NOW + 60_000 });
  assert.equal(declined.state, "declined");
  assert.equal((await readSuggestions(coworkersDir, "nova"))[0].state, "declined");
  await assert.rejects(() => setSuggestionState(coworkersDir, "nova", "sug_missing", "accepted"), /not on record/);
  await assert.rejects(() => setSuggestionState(coworkersDir, "nova", suggestion.id, "lost"), /Unknown suggestion state/);

  const referral = await recordReferral(coworkersDir, "nova", { to: "editor", message: "Draft the launch announcement", why: "Editor writes" }, { now: NOW });
  assert.match(referral.id, /^ref_[a-f0-9]{20}$/);
  assert.equal(referral.from, "nova");
  await setReferralState(coworkersDir, "nova", referral.id, "asked", { now: NOW + 1 });
  assert.equal((await readReferrals(coworkersDir, "nova"))[0].state, "asked");

  const states = await teamStates(coworkersDir, "nova");
  assert.deepEqual(states.suggestions, [{ id: suggestion.id, state: "declined", at: NOW + 60_000, createdSlug: "" }]);
  assert.deepEqual(states.referrals, [{ id: referral.id, state: "asked", at: NOW + 1 }]);
  assert.deepEqual(await teamStates(coworkersDir, "editor"), { suggestions: [], referrals: [] });

  // The decline reaches the coworker through its team description on the next refresh.
  await writeTeamRoster(coworkersDir, nova, [nova, editor], { now: NOW + 2 * 60_000 });
  const roster = await readFile(path.join(nova.path, "team", "roster.md"), "utf8");
  assert.match(roster, /## Recently declined/);
  assert.match(roster, /- a customer support coworker — Sep 3/);
  assert.match(roster, /- Editor \(`editor`\)/);
  assert.equal(await writeTeamRoster(coworkersDir, nova, [nova, editor], { now: NOW + 2 * 60_000 }), false, "an unchanged description is not rewritten");
});
