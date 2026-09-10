import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { currentTestEvidence } from "@openwork/test-evidence";
import { toSessionGroups, type RouteSession, type RouteWorkspace } from "../../apps/app/src/react-app/shell/route-workspaces.ts";
import { flattenSessionRows, partitionArchivedSessions, workspaceConversationCount } from "../../apps/app/src/react-app/domains/session/sidebar/utils.ts";

// Ownership inventory fixes a longstanding UX inconsistency, not a removed badge.
// Preview/group/pin state must not change the total; an absent load is not zero.
test("workspace counts require a complete healthy inventory and count unarchived roots independently of presentation", () => {
  const workspace: RouteWorkspace = { id: "inventory", name: "Inventory", path: "/synthetic/inventory", workspaceType: "local", displayNameResolved: "Inventory" };
  const sessions: RouteSession[] = Array.from({ length: 9 }, (_, index) => ({
    id: `ses_${index}`, title: `Conversation ${index}`, slug: `conversation-${index}`,
    projectID: "synthetic", directory: workspace.path, version: "synthetic",
    time: { created: 1, updated: 1, archived: index === 8 ? 1 : 0 },
    ...(index === 7 ? { parentID: "missing-parent" } : {}),
  }));
  sessions.push({ ...sessions[8], id: "archived-child", parentID: "ses_0" });
  const groups = (loaded: boolean, loading = false, error: string | null = null) => toSessionGroups(
    [workspace, { ...workspace, id: "empty" }], { inventory: sessions, empty: [] },
    { inventory: error }, loading ? new Set([workspace.id]) : new Set(),
    loaded ? new Set([workspace.id, "empty"]) : new Set(),
  );
  expect(groups(false).map(workspaceConversationCount)).toEqual([undefined, undefined]);
  expect(workspaceConversationCount(groups(true, true)[0])).toBeUndefined();
  expect(workspaceConversationCount(groups(true, false, "Unavailable")[0])).toBeUndefined();
  expect(groups(true).map(workspaceConversationCount)).toEqual([7, 0]);
  const group = groups(true)[0];
  const pins = new Set(["ses_0", "ses_1"]);
  expect(flattenSessionRows(group.sessions, 3, new Set(), [], { exclude: pins })).toHaveLength(3);
  expect(flattenSessionRows(group.sessions, 100, new Set(), [], { exclude: pins })).toHaveLength(5);
  expect(workspaceConversationCount(group)).toBe(7);
  expect(partitionArchivedSessions(group.sessions).archived.map(session => session.id)).toEqual(["ses_8", "archived-child"]);
  expect(workspaceConversationCount({ ...group, sessions: group.sessions.map(session => session.id === "ses_0" ? { ...session, time: { archived: 1 } } : session) })).toBe(6);
  expect(workspaceConversationCount({ ...group, sessions: [{ id: "blank-parent", title: "Root", parentID: "  " }] })).toBe(1);
  currentTestEvidence()?.recordAssertionEvidence(
    "Workspace totals represent healthy loaded ownership inventory, never preview size or unknown zero",
    "Two workspace groups produced 7 and confirmed 0; unloaded, loading and failed inventory withheld the number. Pins changed previews from 3 to 5 without changing 7. Children were excluded, whitespace parent IDs remained roots, archive reduced only the owning total, and Archived retained both its root and child records.", true,
  );
});
