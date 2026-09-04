import { patternDrafts, rolesForPattern, workPattern, teamAdvicePrompt } from "./work-patterns.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TeamDraft, TeamRole } from "./bridge.ts";
import {
  MAX_TEAM_DRAFTS,
  ONBOARDING_DRAFT_KEY,
  addDraft,
  clearOnboardingDraft,
  describeIntents,
  draftsToCreate,
  emptyOnboardingDraft,
  firstNoteFor,
  loadOnboardingDraft,
  nameIsFree,
  remainingRoles,
  removeDraft,
  renameDraft,
  saveOnboardingDraft,
  slugOfName,
  toggleIntent,
} from "./onboarding-team.ts";

const CATALOG: TeamRole[] = [
  { id: "research", defaultName: "Scout", role: "Research and synthesis", pitch: "Digging in", mission: "I dig.", avatarColor: "blue", avatarGlasses: "round", personality: "curious" },
  { id: "writing", defaultName: "Editor", role: "Writing and content", pitch: "Drafts", mission: "I write.", avatarColor: "violet", avatarGlasses: "square", personality: "thoughtful" },
  { id: "operations", defaultName: "Ops", role: "Operations and scheduling", pitch: "Schedules", mission: "I schedule.", avatarColor: "mint", avatarGlasses: "round", personality: "meticulous" },
];

function draft(role: TeamRole, name = role.defaultName): TeamDraft {
  return { roleId: role.id, name, role: role.role, mission: role.mission, avatarColor: role.avatarColor, avatarGlasses: role.avatarGlasses, personality: role.personality };
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

test("intents toggle in the order picked", () => {
  assert.deepEqual(toggleIntent([], "writing"), ["writing"]);
  assert.deepEqual(toggleIntent(["writing"], "research"), ["writing", "research"]);
  assert.deepEqual(toggleIntent(["writing", "research"], "writing"), ["research"]);
});

test("the draft survives a reload and a torn store, and clears when the team exists", () => {
  const storage = memoryStorage();
  assert.equal(loadOnboardingDraft(storage).drafts.length, 0, "nothing stored yet gives a fresh draft");
  const fresh = emptyOnboardingDraft();
  assert.match(fresh.draftId, /^draft_/);
  const saved = { ...fresh, intents: ["research"], drafts: [draft(CATALOG[0]!, "Nova")], createdSlugs: ["nova"] };
  saveOnboardingDraft(storage, saved);
  assert.deepEqual(loadOnboardingDraft(storage), saved);
  storage.data.set(ONBOARDING_DRAFT_KEY, "{not json");
  assert.notEqual(loadOnboardingDraft(storage).draftId, saved.draftId, "a torn store starts over rather than failing");
  storage.data.set(ONBOARDING_DRAFT_KEY, JSON.stringify({ draftId: "draft_x", drafts: [{ nope: true }, draft(CATALOG[1]!)], intents: ["writing", 3] }));
  const partial = loadOnboardingDraft(storage);
  assert.deepEqual(partial.drafts.map((item) => item.name), ["Editor"], "malformed drafts are dropped");
  assert.deepEqual(partial.intents, ["writing"]);
  clearOnboardingDraft(storage);
  assert.equal(storage.data.has(ONBOARDING_DRAFT_KEY), false);
  assert.equal(loadOnboardingDraft(null).drafts.length, 0, "no storage at all still works");
});

test("renaming keeps names unique, an empty name restores the default, removing keeps at least one", () => {
  const drafts = [draft(CATALOG[0]!), draft(CATALOG[1]!)];
  assert.deepEqual(renameDraft(drafts, 0, "  Nova ", CATALOG).map((item) => item.name), ["Nova", "Editor"]);
  assert.deepEqual(renameDraft(drafts, 0, "", CATALOG).map((item) => item.name), ["Scout", "Editor"]);
  assert.deepEqual(renameDraft(drafts, 0, "editor", CATALOG).map((item) => item.name), ["Scout", "Editor"], "a taken name is refused");
  assert.deepEqual(renameDraft(drafts, 0, "x".repeat(60), CATALOG)[0]?.name.length, 40);
  assert.deepEqual(renameDraft(drafts, 5, "Ghost", CATALOG), drafts);
  assert.equal(nameIsFree(drafts, "Scout"), false);
  assert.equal(nameIsFree(drafts, "Scout", 0), true);
  assert.equal(slugOfName("Émile's QA — bot!"), "miles-qa-bot");
  assert.deepEqual(removeDraft(drafts, 1).map((item) => item.name), ["Scout"]);
  assert.deepEqual(removeDraft([draft(CATALOG[0]!)], 0).map((item) => item.name), ["Scout"], "the last coworker stays");
});

test("adding another role picks from what is left and names it uniquely", () => {
  const drafts = [draft(CATALOG[0]!), draft(CATALOG[1]!)];
  assert.deepEqual(remainingRoles(CATALOG, drafts).map((role) => role.id), ["operations"]);
  const added = addDraft(drafts, CATALOG[2]!);
  assert.deepEqual(added.map((item) => item.name), ["Scout", "Editor", "Ops"]);
  assert.deepEqual(addDraft(added, CATALOG[2]!), added, "a role already on the team is not added twice");
  const renamedToOps = renameDraft(drafts, 1, "Ops", CATALOG);
  assert.equal(addDraft(renamedToOps, CATALOG[2]!)[2]?.name, "Ops 2", "a default name the person already used gets a number");
  const full = Array.from({ length: MAX_TEAM_DRAFTS }, (_, index) => ({ ...draft(CATALOG[0]!, `C${index}`), roleId: `r${index}` }));
  assert.equal(addDraft(full, CATALOG[2]!).length, MAX_TEAM_DRAFTS);
});

test("the first memory line names the day and what the team is for", () => {
  const now = Date.UTC(2026, 8, 3, 15);
  assert.equal(describeIntents(["research"], CATALOG), "research");
  assert.equal(describeIntents(["research", "writing"], CATALOG), "research and writing");
  assert.equal(describeIntents(["research", "writing", "operations"], CATALOG), "research, writing, and operations");
  assert.equal(describeIntents(["wizard"], CATALOG), "");
  assert.equal(firstNoteFor(["research", "writing"], CATALOG, now), "Joined the team on Sep 3 to help with research and writing.");
  assert.equal(firstNoteFor([], CATALOG, now), "Joined the team on Sep 3.");
});

test("a retry creates only what an earlier attempt did not", () => {
  const drafts = [draft(CATALOG[0]!, "Nova"), draft(CATALOG[1]!), draft(CATALOG[2]!)];
  assert.deepEqual(draftsToCreate(drafts, ["nova"], []).map((item) => item.name), ["Editor", "Ops"]);
  assert.deepEqual(draftsToCreate(drafts, [], ["editor"]).map((item) => item.name), ["Nova", "Ops"], "a coworker that already exists on disk is skipped too");
  assert.deepEqual(draftsToCreate(drafts, ["nova", "editor", "ops"], []), []);
});


test("profession suggestions customize only their roles and keep unrelated choices editable", () => {
  const roles = rolesForPattern(CATALOG, "marketing");
  assert.deepEqual(roles.map((role) => role.id), ["research", "writing", "operations"]);
  assert.match(roles[0]!.mission, /campaign brief/);
  const drafts = patternDrafts([draft(CATALOG[0]!), draft(CATALOG[2]!)], "marketing");
  assert.match(drafts[0]!.mission, /campaign brief/);
  assert.equal(drafts[1]!.mission, CATALOG[2]!.mission);
  assert.deepEqual(patternDrafts(drafts, "unknown"), drafts);
  assert.equal(workPattern("unknown"), undefined);
});

test("AI team advice includes the person's work, existing teammates, and explicit review boundaries", () => {
  const prompt = teamAdvicePrompt("  Prepare weekly client briefs  ", "consulting");
  assert.match(prompt, /Consulting & research/);
  assert.match(prompt, /What I need: Prepare weekly client briefs/);
  assert.match(prompt, /Prefer existing teammates/);
  assert.match(prompt, /I will decide whether to add them/);
  assert.match(prompt, /Do not create schedules/);
});
