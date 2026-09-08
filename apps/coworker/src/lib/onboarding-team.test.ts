import assert from "node:assert/strict";
import { test } from "node:test";
import type { TeamDraft, TeamRole } from "./bridge.ts";
import {
  ONBOARDING_DRAFT_KEY,
  clearOnboardingDraft,
  draftsToCreate,
  emptyOnboardingDraft,
  loadOnboardingDraft,
  removeDraft,
  renameDraft,
  saveOnboardingDraft,
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

test("renaming refuses a collision and removal keeps at least one coworker", () => {
  const drafts = [draft(CATALOG[0]!), draft(CATALOG[1]!)];
  assert.deepEqual(renameDraft(drafts, 0, "editor", CATALOG).map((item) => item.name), ["Scout", "Editor"], "a taken name is refused");
  assert.deepEqual(removeDraft(drafts, 1).map((item) => item.name), ["Scout"]);
  assert.deepEqual(removeDraft([draft(CATALOG[0]!)], 0).map((item) => item.name), ["Scout"], "the last coworker stays");
});

test("a retry creates only what an earlier attempt did not", () => {
  const drafts = [draft(CATALOG[0]!, "Nova"), draft(CATALOG[1]!), draft(CATALOG[2]!)];
  assert.deepEqual(draftsToCreate(drafts, ["nova"], []).map((item) => item.name), ["Editor", "Ops"]);
  assert.deepEqual(draftsToCreate(drafts, [], ["editor"]).map((item) => item.name), ["Nova", "Ops"], "a coworker that already exists on disk is skipped too");
  assert.deepEqual(draftsToCreate(drafts, ["nova", "editor", "ops"], []), []);
});
