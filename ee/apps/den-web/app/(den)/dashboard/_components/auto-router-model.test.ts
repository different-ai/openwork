import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_ROUTER_MAX_TASKS_PER_MODEL, type AutoRouter } from "@openwork/types/den/auto-router";
import {
  accessGapSentence,
  addTask,
  assignmentSummary,
  draftProblem,
  assignmentIsEmpty,
  draftToWrite,
  membersWithoutAccess,
  mergeTasks,
  reachedMemberIds,
  routerToDraft,
  rowTasks,
  type RouterDirectory,
  type RouterDraft,
} from "./auto-router-model";

const person = (id: string, name: string, joined = true) => ({
  id,
  userId: joined ? `user_${id}` : null,
  user: { id: `user_${id}`, email: `${name.toLowerCase()}@example.com`, name, image: null },
});

const directory: RouterDirectory = {
  members: [person("m1", "Maya"), person("m2", "Sam"), person("m3", "Ada"), person("m4", "Lin"), person("m5", "Invited", false)],
  teams: [
    { id: "t_eng", name: "Engineering", memberIds: ["m1", "m2"] },
    { id: "t_ops", name: "Operations", memberIds: ["m3", "m5"] },
  ],
};

test("everyone reaches every joined member, not pending invites", () => {
  assert.deepEqual(reachedMemberIds({ everyone: true, teamIds: [], memberIds: [] }, directory), ["m1", "m2", "m3", "m4"]);
});

test("teams and members reach each person once", () => {
  assert.deepEqual(reachedMemberIds({ everyone: false, teamIds: ["t_eng", "t_ops"], memberIds: ["m2", "m4"] }, directory), ["m1", "m2", "m3", "m4"]);
  assert.deepEqual(reachedMemberIds({ everyone: false, teamIds: [], memberIds: [] }, directory), []);
});

test("a model everyone can use leaves nobody out", () => {
  const reached = reachedMemberIds({ everyone: true, teamIds: [], memberIds: [] }, directory);
  assert.deepEqual(membersWithoutAccess({ everyone: true, teamIds: [], memberIds: [] }, reached, directory), []);
});

test("people outside the model's teams and members are listed", () => {
  const reached = reachedMemberIds({ everyone: true, teamIds: [], memberIds: [] }, directory);
  assert.deepEqual(membersWithoutAccess({ everyone: false, teamIds: ["t_eng"], memberIds: ["m4"] }, reached, directory), ["m3"]);
  assert.deepEqual(membersWithoutAccess({ everyone: false, teamIds: [], memberIds: [] }, reached, directory), ["m1", "m2", "m3", "m4"]);
});

test("a router for a team the model covers has no gap", () => {
  const reached = reachedMemberIds({ everyone: false, teamIds: ["t_eng"], memberIds: [] }, directory);
  assert.deepEqual(membersWithoutAccess({ everyone: false, teamIds: [], memberIds: ["m1", "m2"] }, reached, directory), []);
});

test("the gap sentence names a few people and counts the rest", () => {
  assert.equal(accessGapSentence(["m3"], directory), "Ada doesn't have access to this model.");
  assert.equal(accessGapSentence(["m1", "m2", "m3", "m4"], directory), "Maya, Sam, Ada and 1 more don't have access to this model.");
  assert.equal(accessGapSentence([], directory), "");
});

test("the audience summary puts teams before people", () => {
  assert.equal(assignmentSummary({ everyone: true, teamIds: ["t_eng"], memberIds: [] }, directory), "Everyone");
  assert.equal(assignmentSummary({ everyone: false, teamIds: ["t_eng"], memberIds: ["m3"] }, directory), "Engineering and Ada");
  assert.equal(assignmentSummary({ everyone: false, teamIds: [], memberIds: [] }, directory), "Nobody yet");
});

test("tasks merge case-insensitively and keep the first spelling", () => {
  assert.deepEqual(mergeTasks(["Code review", "Writing"], ["code  REVIEW", " Data analysis "]), ["Code review", "Writing", "Data analysis"]);
});

test("adding a task normalizes it, reuses the org spelling and skips duplicates", () => {
  assert.deepEqual(addTask([], "  quick   questions "), ["quick questions"]);
  assert.deepEqual(addTask([], "code review", ["Code Review"]), ["Code Review"]);
  assert.deepEqual(addTask(["Code Review"], "CODE review"), ["Code Review"]);
  assert.deepEqual(addTask(["Writing"], "   "), ["Writing"]);
});

test("adding stops at the per-model task limit", () => {
  const full = Array.from({ length: AUTO_ROUTER_MAX_TASKS_PER_MODEL }, (_, index) => `Task ${index}`);
  assert.equal(addTask(full, "One more").length, AUTO_ROUTER_MAX_TASKS_PER_MODEL);
});

test("text still typed in the task box is saved as a task", () => {
  assert.deepEqual(rowTasks({ tasks: ["Writing"], pending: " summaries " }), ["Writing", "summaries"]);
  assert.deepEqual(rowTasks({ tasks: ["Writing"], pending: "writing" }), ["Writing"]);
});

const router: AutoRouter = {
  id: "ar_1",
  name: "Engineering",
  assignment: { everyone: false, teamIds: ["t_eng"], memberIds: [] },
  models: [
    { id: "m_a", providerId: "ipr_a", modelId: "fast", tasks: ["Quick questions"] },
    { id: "m_b", providerId: "ipr_b", modelId: "deep", tasks: ["Code review", "Quick questions"] },
  ],
  updatedAt: "2026-10-30T00:00:00.000Z",
};

test("a saved router round-trips through the draft in order", () => {
  let next = 0;
  const draft = routerToDraft(router, () => `row${next++}`);
  assert.deepEqual(draftToWrite(draft), {
    name: "Engineering",
    models: [
      { providerId: "ipr_a", modelId: "fast", tasks: ["Quick questions"] },
      { providerId: "ipr_b", modelId: "deep", tasks: ["Code review", "Quick questions"] },
    ],
  });
});

test("a new router starts with one empty model row; who it applies to is the second step", () => {
  const draft = routerToDraft(null, () => "row");
  assert.deepEqual(draft, { name: "", models: [{ key: "row", model: null, tasks: [], pending: "" }] });
  assert.equal(assignmentIsEmpty({ everyone: false, teamIds: [], memberIds: [] }), true);
  assert.equal(assignmentIsEmpty({ everyone: false, teamIds: ["t_eng"], memberIds: [] }), false);
  assert.equal(assignmentIsEmpty({ everyone: true, teamIds: [], memberIds: [] }), false);
});

test("drafts explain what is missing before they can be saved", () => {
  const base: RouterDraft = {
    name: "Support",
    models: [{ key: "a", model: { providerId: "ipr_a", modelId: "fast" }, tasks: [], pending: "" }],
  };
  assert.equal(draftProblem({ ...base, name: "  " }), "Name this Smart Router.");
  assert.equal(draftProblem({ ...base, models: [] }), "Add at least one model.");
  assert.equal(draftProblem({ ...base, models: [{ key: "a", model: null, tasks: ["Writing"], pending: "" }] }), "Choose a model for every row.");
  assert.equal(draftProblem(base), "Add at least one task for every model.");
  assert.equal(draftToWrite(base), null);
  // Typed but not entered still counts.
  const typed = { ...base, models: [{ ...base.models[0], pending: "Refunds" }] };
  assert.equal(draftProblem(typed), null);
  assert.deepEqual(draftToWrite(typed, ["refunds"])?.models[0]?.tasks, ["refunds"]);
});
