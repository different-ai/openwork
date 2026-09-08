import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createCoworker } from "./coworkers.mjs";
import { createCoworkerToolsServer } from "./coworker-tools.mjs";
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

async function team(t) {
  const coworkersDir = await tempCoworkersDir();
  await createCoworker(coworkersDir, { name: "Nova", role: "Research and synthesis", mission: "I dig into questions.", roleId: "research" });
  await createCoworker(coworkersDir, { name: "Editor", role: "Writing and content", mission: "I turn rough ideas into drafts.", roleId: "writing" });
  const handlers = createTeamToolHandlers({ coworkersDir, now: () => NOW });
  const server = await createCoworkerToolsServer({ resolveSlug: (token) => token === "nova-token" ? "nova" : null, handlers, tools: teamToolCatalog() });
  t.after(() => server.stop());
  const call = async (name, args, token = "nova-token") => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return { status: response.status, ...await response.json() };
  };
  return { coworkersDir, call };
}

test("authenticated team dispatch records referrals only for its owner and rejects invalid actions", async (t) => {
  const { coworkersDir, call } = await team(t);
  assert.equal((await call("team_refer", { to: "editor", message: "No authority", why: "x" }, "unknown-token")).status, 401);
  assert.deepEqual(await readReferrals(coworkersDir, "nova"), []);
  const byName = await call("team_refer", { to: "editor", message: "Draft the launch announcement", why: "Editor writes for a living." });
  assert.equal(byName.status, 200);
  assert.equal(byName.result.isError, false);
  const referral = byName.result.structuredContent.referral;
  assert.equal(referral.to.slug, "editor");
  assert.equal((await readReferrals(coworkersDir, "nova"))[0].id, referral.id);
  assert.deepEqual(await readReferrals(coworkersDir, "editor"), []);

  const unknown = await call("team_refer", { to: "Care", message: "Watch the inbox", why: "support" });
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.content[0].text, /^Couldn't offer to pass this on: Nobody on the team is called "Care"/);
  const self = await call("team_refer", { to: "Nova", message: "Research this", why: "research" });
  assert.equal(self.result.isError, true);
  assert.match(self.result.content[0].text, /That is you\. Do the work yourself/);
  const missing = await call("team_refer", { to: "editor", message: "", why: "y" });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /Include the person's request in their own words/);
  assert.equal((await call("team_delete", {})).error.code, -32602);
  assert.equal((await readReferrals(coworkersDir, "nova")).length, 1);
});

test("team_refer does not offer a request again once the person chose to keep it with the coworker", async (t) => {
  const { coworkersDir, call } = await team(t);
  const first = await call("team_refer", { to: "editor", message: "Draft the launch announcement", why: "Editor writes for a living." });
  assert.equal(first.result.isError, false);
  await setReferralState(coworkersDir, "nova", first.result.structuredContent.referral.id, "continued", { now: NOW + 60_000 });
  const again = await call("team_refer", { to: "editor", message: "draft the launch announcement", why: "Editor writes for a living." });
  assert.equal(again.result.isError, false, "a kept request is a check, not a failure");
  assert.deepEqual(again.result.structuredContent, { kept: { at: NOW + 60_000 } });
  assert.equal((await readReferrals(coworkersDir, "nova")).length, 1, "nothing new is recorded");
  const other = await call("team_refer", { to: "editor", message: "Rewrite the pricing page", why: "Editor writes for a living." });
  assert.equal(other.result.isError, false);
  assert.ok(other.result.structuredContent.referral, "a different request may still be offered");
});

test("team_suggest records at most one proposal and refuses existing or invalid roles", async (t) => {
  const { coworkersDir, call } = await team(t);
  const first = await call("team_suggest", { role: "support", mission: "I watch the inbox and answer with care.", why: "The support inbox comes up every morning." });
  assert.equal(first.result.isError, false);
  const suggestion = first.result.structuredContent.suggestion;
  assert.equal(suggestion.by, "nova");
  assert.equal(suggestion.roleId, "support");

  // Already covered by a teammate: no card, a nudge to refer instead.
  const covered = await call("team_suggest", { role: "writing", mission: "I write.", why: "The person asked for a writer." });
  assert.equal(covered.result.isError, false);
  assert.equal(covered.result.structuredContent.existing.slug, "editor");
  assert.equal(covered.result.structuredContent.suggestion, undefined);
  // The caller's own job is not a teammate to propose.
  const own = await call("team_suggest", { role: "research", mission: "I research.", why: "Research came up." });
  assert.equal(own.result.structuredContent.self, true);

  // One a day: a second proposal the same day is turned down without a card.
  const second = await call("team_suggest", { role: "sales", mission: "I keep leads warm.", why: "Leads keep coming up." });
  assert.equal(second.result.structuredContent.limit, "daily");
  assert.equal((await readSuggestions(coworkersDir, "nova")).length, 1, "a refused proposal is not recorded");

  const missing = await call("team_suggest", { role: "", mission: "x", why: "y" });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /^Couldn't suggest a teammate: Say what role/);
});
