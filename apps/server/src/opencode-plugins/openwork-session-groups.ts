import { z } from "zod";
import { strictArgsSchema } from "./openwork-provider-adapters.js";

// Sidebar groups live in the OpenWork server's workspace store, so the agent
// changes them there directly. Nothing here needs the desktop window: the app
// follows these writes through its session-group event feed.

export const SESSION_GROUP_COMMAND_IDS = ["session.group.create", "session.group.move", "session.group.remove"] as const;
export const SESSION_GROUP_AFFORDANCE_IDS: readonly string[] = ["session.group.list", ...SESSION_GROUP_COMMAND_IDS];

const workspaceIdArg = z.string().trim().optional()
  .describe("Optional OpenWork workspace id/name. Defaults to the workspace of the session involved.");

export const sessionGroupListArgsSchema = strictArgsSchema({ workspaceId: workspaceIdArg });
export const sessionGroupCreateArgsSchema = strictArgsSchema({
  label: z.string().trim().min(1).max(120).describe("Group name shown in the sidebar, for example \"Done\" or \"In progress\"."),
  workspaceId: workspaceIdArg,
});
export const sessionGroupMoveArgsSchema = strictArgsSchema({
  sessionId: z.string().trim().min(1).describe("Session ID from session.search, session.read or session.group.list."),
  groupId: z.string().trim().nullable().optional().describe("Group id or exact label from session.group.list. Omit or null to ungroup."),
  workspaceId: workspaceIdArg,
});
export const sessionGroupRemoveArgsSchema = strictArgsSchema({
  groupId: z.string().trim().min(1).describe("Group id or exact label to remove. Its sessions are kept."),
  destinationGroupId: z.string().trim().optional().describe("Optional group id or label that receives the removed group's sessions. Omit to leave them ungrouped."),
  confirmed: z.literal(true).describe("Must be true: the person asked for this group to be removed."),
  workspaceId: workspaceIdArg,
});

const sessionGroupStateSchema = z.object({
  state: z.object({
    groups: z.array(z.object({ id: z.string(), label: z.string() })),
    assignments: z.record(z.string(), z.string()),
  }),
});
type SessionGroupState = z.infer<typeof sessionGroupStateSchema>["state"];
type SessionGroup = SessionGroupState["groups"][number];

export type SessionGroupHost = {
  get(path: string): Promise<unknown>;
  send(method: "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>): Promise<unknown>;
  /** Root session titles by id, or null when the full list could not be read. */
  liveSessions(workspaceId: string): Promise<Map<string, string> | null>;
};

type Failure = { ok: false; error: string };

// Bounds the cleanup done alongside one command; the rest goes on the next one.
const STALE_PRUNE_LIMIT = 50;

function groupsPath(workspaceId: string, suffix = ""): string {
  return `/workspace/${encodeURIComponent(workspaceId)}/session-groups${suffix}`;
}

async function readState(host: SessionGroupHost, workspaceId: string): Promise<SessionGroupState> {
  return sessionGroupStateSchema.parse(await host.get(groupsPath(workspaceId))).state;
}

function describeGroups(state: SessionGroupState): string {
  return state.groups.length
    ? state.groups.map((group) => `${group.label} (${group.id})`).join(", ")
    : "none yet; create one with session.group.create";
}

/** An exact id wins; otherwise one case-insensitive label match. */
function resolveGroup(state: SessionGroupState, ref: string): SessionGroup | Failure {
  const byId = state.groups.find((group) => group.id === ref);
  if (byId) return byId;
  const label = ref.toLowerCase();
  const byLabel = state.groups.filter((group) => group.label.trim().toLowerCase() === label);
  if (byLabel.length === 1 && byLabel[0]) return byLabel[0];
  if (byLabel.length > 1) return { ok: false, error: `Several groups are named ${ref}; pass one id: ${byLabel.map((group) => group.id).join(", ")}` };
  return { ok: false, error: `No group matched ${ref}. Groups: ${describeGroups(state)}` };
}

function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && Reflect.get(value, "ok") === false;
}

function staleSessionIds(state: SessionGroupState, live: Map<string, string> | null): string[] {
  if (!live) return [];
  return Object.keys(state.assignments).filter((sessionId) => !live.has(sessionId));
}

/**
 * Drop assignments whose session no longer exists, one key at a time so a
 * concurrent sidebar edit is never overwritten. Skipped when the session list
 * is incomplete: an unknown session is not proof that it was deleted.
 */
async function pruneStaleAssignments(host: SessionGroupHost, workspaceId: string, state: SessionGroupState, live: Map<string, string> | null): Promise<number> {
  const stale = staleSessionIds(state, live).slice(0, STALE_PRUNE_LIMIT);
  for (const sessionId of stale) {
    await host.send("PATCH", groupsPath(workspaceId, `/assignments/${encodeURIComponent(sessionId)}`), {});
  }
  return stale.length;
}

export async function listSessionGroups(host: SessionGroupHost, workspaceId: string) {
  const [state, live] = await Promise.all([readState(host, workspaceId), host.liveSessions(workspaceId)]);
  const stale = new Set(staleSessionIds(state, live));
  const sessionsByGroup = new Map<string, Array<{ sessionId: string; title?: string }>>();
  for (const [sessionId, groupId] of Object.entries(state.assignments)) {
    if (stale.has(sessionId)) continue;
    const title = live?.get(sessionId);
    sessionsByGroup.set(groupId, [...(sessionsByGroup.get(groupId) ?? []), { sessionId, ...(title ? { title } : {}) }]);
  }
  return {
    ok: true as const,
    workspaceId,
    groups: state.groups.map((group) => ({ id: group.id, label: group.label, sessions: sessionsByGroup.get(group.id) ?? [] })),
    // Sessions not listed under any group are ungrouped.
    ...(stale.size ? { staleAssignments: stale.size } : {}),
    ...(live ? {} : { note: "Session titles are unavailable; deleted sessions may still be listed." }),
  };
}

export async function createSessionGroup(host: SessionGroupHost, workspaceId: string, label: string) {
  const [state, live] = await Promise.all([readState(host, workspaceId), host.liveSessions(workspaceId)]);
  const pruned = await pruneStaleAssignments(host, workspaceId, state, live);
  // Retried or repeated requests reuse the group instead of adding a twin.
  const existing = state.groups.find((group) => group.label.trim().toLowerCase() === label.toLowerCase());
  if (existing) return { ok: true as const, workspaceId, groupId: existing.id, label: existing.label, created: false, ...(pruned ? { pruned } : {}) };
  const after = sessionGroupStateSchema.parse(await host.send("POST", groupsPath(workspaceId), { label })).state;
  const created = [...after.groups].reverse().find((group) => group.label === label);
  if (!created) return { ok: false as const, error: `The group ${label} was not saved` };
  return { ok: true as const, workspaceId, groupId: created.id, label: created.label, created: true, ...(pruned ? { pruned } : {}) };
}

export async function moveSessionToGroup(host: SessionGroupHost, workspaceId: string, sessionId: string, groupRef: string | null | undefined) {
  const [state, live] = await Promise.all([readState(host, workspaceId), host.liveSessions(workspaceId)]);
  const group = groupRef ? resolveGroup(state, groupRef) : null;
  if (isFailure(group)) return group;
  if (live && !live.has(sessionId)) return { ok: false as const, error: `Session ${sessionId} is not a task in this workspace` };
  const pruned = await pruneStaleAssignments(host, workspaceId, state, live);
  const after = sessionGroupStateSchema.parse(await host.send(
    "PATCH",
    groupsPath(workspaceId, `/assignments/${encodeURIComponent(sessionId)}`),
    group ? { groupId: group.id } : {},
  )).state;
  // The server ignores unknown groups, so confirm the saved assignment.
  if ((after.assignments[sessionId] ?? null) !== (group?.id ?? null)) {
    return { ok: false as const, error: `Session ${sessionId} could not be moved; read session.group.list and retry` };
  }
  return {
    ok: true as const,
    workspaceId,
    sessionId,
    ...(live?.get(sessionId) ? { title: live.get(sessionId) } : {}),
    groupId: group?.id ?? null,
    label: group?.label ?? null,
    ...(pruned ? { pruned } : {}),
  };
}

export async function removeSessionGroup(host: SessionGroupHost, workspaceId: string, groupRef: string, destinationRef: string | undefined) {
  const [state, live] = await Promise.all([readState(host, workspaceId), host.liveSessions(workspaceId)]);
  const group = resolveGroup(state, groupRef);
  if (isFailure(group)) return group;
  const destination = destinationRef ? resolveGroup(state, destinationRef) : null;
  if (isFailure(destination)) return destination;
  if (destination?.id === group.id) return { ok: false as const, error: "The destination must be a different group" };
  const pruned = await pruneStaleAssignments(host, workspaceId, state, live);
  const query = destination ? `?destinationGroupId=${encodeURIComponent(destination.id)}` : "";
  await host.send("DELETE", groupsPath(workspaceId, `/${encodeURIComponent(group.id)}${query}`));
  return {
    ok: true as const,
    workspaceId,
    removedGroupId: group.id,
    label: group.label,
    sessionsMovedTo: destination ? { groupId: destination.id, label: destination.label } : null,
    ...(pruned ? { pruned } : {}),
  };
}
