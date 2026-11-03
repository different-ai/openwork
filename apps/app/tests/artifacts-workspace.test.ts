import { expect, test } from "bun:test";
import { artifactRows, groupArtifacts, readArtifactSelection, rememberArtifactSelection, selectedArtifact } from "../src/react-app/domains/dashboard/artifacts-workspace";
import type { BuiltMcpAppCatalogEntry } from "../src/app/lib/built-mcp-app-catalog";
import type { SavedAppSummary } from "@openwork/types/workflows";

function app(connectionId: string, title: string, isOwner?: boolean): BuiltMcpAppCatalogEntry & { isOwner?: boolean } {
  return { connectionId, title, isOwner, description: null, serverName: "artifacts", toolName: "open_app", projectedToolName: "open_app", resourceUri: `ui://artifacts/${connectionId}`, pluginId: `plugin-${connectionId}`, pluginName: "Workspace", requiresApproval: false };
}

const catalog = [app("overview", "Overview", true), app("notes", "Notes", true), app("queue", "Review queue", false), app("archive", "Archive")];

test("all accessible artifacts appear automatically, grouped exclusively by pin and ownership", () => {
  const rows = artifactRows([...catalog, catalog[0]!], ["overview", "overview", "not-accessible"], []);
  const groups = groupArtifacts(rows);
  expect(groups.map((group) => [group.title, group.rows.map((row) => row.title)])).toEqual([
    ["Pinned", ["Overview"]], ["Yours", ["Notes"]], ["Team", ["Archive", "Review queue"]],
  ]);
  expect(rows).toHaveLength(4);
});

test("legacy saved views stay accessible; management permission is not ownership", () => {
  const saved: SavedAppSummary = {
    view: { id: "saved-view", configObjectId: "config", title: "Saved report", description: null, status: "active", activeRevisionId: null, revisions: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    workflowTitle: "Saved report", canManage: true, onDashboard: false,
  };
  const groups = groupArtifacts(artifactRows([], [], [saved]));
  expect(groups[1]?.rows).toEqual([]);
  expect(groups[2]?.rows.map((row) => row.id)).toEqual(["saved:saved-view"]);
  expect(groupArtifacts(artifactRows([], [], [{ ...saved, onDashboard: true }]))[0]?.rows.map((row) => row.id)).toEqual(["saved:saved-view"]);
});

test("unpinning moves the row without changing the selected artifact identity", () => {
  const pinned = artifactRows(catalog, ["overview"], []);
  const unpinned = artifactRows(catalog, [], []);
  expect(selectedArtifact(pinned, "personal:overview")?.id).toBe(selectedArtifact(unpinned, "personal:overview")?.id);
  expect(groupArtifacts(unpinned)[1]?.rows.map((row) => row.title)).toEqual(["Notes", "Overview"]);
});

test("selection never defaults to an arbitrary app and a removed grant cannot stay selected", () => {
  const rows = artifactRows(catalog, ["overview"], []);
  expect(selectedArtifact(rows, null)).toBeNull();
  expect(selectedArtifact(rows, "personal:not-accessible")).toBeNull();
  expect(selectedArtifact(artifactRows(catalog.slice(1), ["overview"], []), "personal:overview")).toBeNull();
});

test("selection survives remount memory but never crosses member, organization or deployment scopes", () => {
  rememberArtifactSelection("deployment-a/member-a/org-a", "personal:overview");
  expect(readArtifactSelection("deployment-a/member-a/org-a")).toBe("personal:overview");
  expect(readArtifactSelection("deployment-a/member-b/org-a")).toBeNull();
  expect(readArtifactSelection("deployment-a/member-a/org-b")).toBeNull();
  expect(readArtifactSelection("deployment-b/member-a/org-a")).toBeNull();
  rememberArtifactSelection("deployment-a/member-a/org-a", null);
  expect(readArtifactSelection("deployment-a/member-a/org-a")).toBeNull();
});

test("search filters names without changing selection eligibility", () => {
  const rows = artifactRows(catalog, [], []);
  expect(groupArtifacts(rows, "  REVIEW  ")[2]?.rows.map((row) => row.title)).toEqual(["Review queue"]);
  expect(selectedArtifact(rows, "personal:overview")?.title).toBe("Overview");
});
