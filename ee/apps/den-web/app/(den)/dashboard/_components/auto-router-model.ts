import {
  AUTO_ROUTER_MAX_TASKS,
  AUTO_ROUTER_MAX_TASKS_PER_MODEL,
  AUTO_ROUTER_NAME_MAX_LENGTH,
  AUTO_ROUTER_TASK_MAX_LENGTH,
  autoRouterTaskKey,
  normalizeAutoRouterTaskName,
  type AutoRouter,
  type AutoRouterAssignment,
  type AutoRouterModelAccess,
  type AutoRouterWrite,
} from "@openwork/types/den/auto-router";
import type { DenOrgMember, DenOrgTeam } from "../../_lib/den-org";
import { accessNames, joinNames, type AccessDraft } from "./access-summary";

/**
 * Pure logic for the Smart Model Router editor: who a router reaches, who
 * can't use one of its models, and how typed tasks are merged and saved.
 */

export type RouterDirectory = {
  members: readonly Pick<DenOrgMember, "id" | "userId" | "user">[];
  teams: readonly Pick<DenOrgTeam, "id" | "name" | "memberIds">[];
};

export type ModelRef = { providerId: string; modelId: string };

/** One model row while editing; `pending` is task text typed but not yet added. */
export type RouterModelDraft = {
  key: string;
  model: ModelRef | null;
  tasks: string[];
  pending: string;
};

/** Step one of a router: its name and models. Who it applies to is step two. */
export type RouterDraft = {
  name: string;
  models: RouterModelDraft[];
};

export function modelValue(ref: ModelRef): string {
  return `${ref.providerId}::${ref.modelId}`;
}

export function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

export function assignmentToAccess(assignment: AutoRouterAssignment): AccessDraft {
  return { orgWide: assignment.everyone, memberIds: [...assignment.memberIds], teamIds: [...assignment.teamIds] };
}

export function accessToAssignment(access: AccessDraft): AutoRouterAssignment {
  return { everyone: access.orgWide, memberIds: [...access.memberIds], teamIds: [...access.teamIds] };
}

/** Joined people only: pending invites can't use a model yet, so they never count as reached. */
function joinedMemberIds(directory: RouterDirectory): Set<string> {
  return new Set(directory.members.filter((member) => member.userId).map((member) => member.id));
}

function teamMemberIds(teamIds: readonly string[], directory: RouterDirectory): string[] {
  return teamIds.flatMap((teamId) => directory.teams.find((team) => team.id === teamId)?.memberIds ?? []);
}

/** Everyone an assignment reaches, each person once, in directory order. */
export function reachedMemberIds(assignment: AutoRouterAssignment, directory: RouterDirectory): string[] {
  const joined = joinedMemberIds(directory);
  const reached = assignment.everyone
    ? joined
    : new Set([...assignment.memberIds, ...teamMemberIds(assignment.teamIds, directory)].filter((id) => joined.has(id)));
  return directory.members.filter((member) => reached.has(member.id)).map((member) => member.id);
}

/** Of the people a router reaches, those the AI Gateway doesn't let use this model. */
export function membersWithoutAccess(access: AutoRouterModelAccess, reached: readonly string[], directory: RouterDirectory): string[] {
  if (access.everyone) return [];
  const allowed = new Set([...access.memberIds, ...teamMemberIds(access.teamIds, directory)]);
  return reached.filter((id) => !allowed.has(id));
}

function memberName(id: string, directory: RouterDirectory): string {
  const member = directory.members.find((entry) => entry.id === id);
  return member ? member.user.name || member.user.email : "Someone";
}

/** "Maya, Sam and 4 more don't have access to this model." */
export function accessGapSentence(memberIds: readonly string[], directory: RouterDirectory, max = 3): string {
  const names = memberIds.map((id) => memberName(id, directory));
  if (names.length === 0) return "";
  const list = joinNames(names, max);
  return `${list} ${names.length === 1 ? "doesn't" : "don't"} have access to this model.`;
}

/** Whether a router applies to anyone yet. */
export function assignmentIsEmpty(assignment: AutoRouterAssignment): boolean {
  return !assignment.everyone && assignment.teamIds.length === 0 && assignment.memberIds.length === 0;
}

/** The list row's audience: "Everyone", "Engineering and Maya", or "Nobody yet". */
export function assignmentSummary(assignment: AutoRouterAssignment, directory: RouterDirectory): string {
  if (assignment.everyone) return "Everyone";
  const draft = assignmentToAccess(assignment);
  // Teams first: they usually describe the audience better than a list of people.
  const people = accessNames({ ...draft, teamIds: [] }, directory, null);
  const teams = accessNames({ ...draft, memberIds: [] }, directory, null);
  const names = [...teams, ...people];
  return names.length === 0 ? "Nobody yet" : joinNames(names);
}

/** Task names, each once by key, keeping the first spelling seen. */
export function mergeTasks(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const name = normalizeAutoRouterTaskName(raw);
      const key = autoRouterTaskKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(name);
    }
  }
  return merged;
}

/**
 * Adds a typed task to a model's tasks. Uses the organization's spelling when
 * the task already exists, ignores duplicates, and stops at the per-model limit.
 */
export function addTask(tasks: readonly string[], raw: string, known: readonly string[] = []): string[] {
  const name = normalizeAutoRouterTaskName(raw).slice(0, AUTO_ROUTER_TASK_MAX_LENGTH).trim();
  const key = autoRouterTaskKey(name);
  if (!key || tasks.some((task) => autoRouterTaskKey(task) === key)) return [...tasks];
  if (tasks.length >= AUTO_ROUTER_MAX_TASKS_PER_MODEL) return [...tasks];
  const existing = known.find((task) => autoRouterTaskKey(task) === key);
  return [...tasks, existing ?? name];
}

/** The tasks a row saves: its chips plus any text still typed in the box. */
export function rowTasks(row: Pick<RouterModelDraft, "tasks" | "pending">, known: readonly string[] = []): string[] {
  return row.pending.trim() ? addTask(row.tasks, row.pending, known) : [...row.tasks];
}

export function routerToDraft(router: AutoRouter | null, newKey: () => string): RouterDraft {
  if (!router) return { name: "", models: [{ key: newKey(), model: null, tasks: [], pending: "" }] };
  return {
    name: router.name,
    models: router.models.map((model) => ({
      key: newKey(),
      model: { providerId: model.providerId, modelId: model.modelId },
      tasks: [...model.tasks],
      pending: "",
    })),
  };
}

/** Why the draft can't be saved yet, in the words shown next to Save, or null. */
export function draftProblem(draft: RouterDraft, known: readonly string[] = []): string | null {
  const name = draft.name.trim();
  if (!name) return "Name this Smart Router.";
  if (name.length > AUTO_ROUTER_NAME_MAX_LENGTH) return `Use a name up to ${AUTO_ROUTER_NAME_MAX_LENGTH} characters.`;
  if (draft.models.length === 0) return "Add at least one model.";
  if (draft.models.some((row) => !row.model)) return "Choose a model for every row.";
  if (draft.models.some((row) => rowTasks(row, known).length === 0)) return "Add at least one task for every model.";
  const tasks = mergeTasks(...draft.models.map((row) => rowTasks(row, known)));
  if (tasks.length > AUTO_ROUTER_MAX_TASKS) return `A Smart Router can have at most ${AUTO_ROUTER_MAX_TASKS} different tasks.`;
  return null;
}

/** The request body, or null while the draft has a problem. */
export function draftToWrite(draft: RouterDraft, known: readonly string[] = []): AutoRouterWrite | null {
  if (draftProblem(draft, known)) return null;
  const models = draft.models.flatMap((row) => row.model
    ? [{ providerId: row.model.providerId, modelId: row.model.modelId, tasks: rowTasks(row, known) }]
    : []);
  return { name: draft.name.trim(), models };
}
