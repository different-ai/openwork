import type { SavedAppSummary } from "@openwork/types/workflows";
import type { BuiltMcpAppCatalogEntry } from "@/app/lib/built-mcp-app-catalog";

export type ArtifactRow =
  | { kind: "built"; id: string; title: string; pinned: boolean; isOwner: boolean; app: BuiltMcpAppCatalogEntry }
  | { kind: "saved"; id: string; title: string; pinned: boolean; isOwner: boolean; app: SavedAppSummary };

export type ArtifactGroup = { title: "Pinned" | "Yours" | "Team"; rows: ArtifactRow[] };

/** Placement never determines access: every accessible catalog entry gets a row. */
export function artifactRows(
  builtApps: readonly BuiltMcpAppCatalogEntry[],
  pinnedIds: readonly string[],
  savedApps: readonly SavedAppSummary[],
): ArtifactRow[] {
  const pinned = new Set(pinnedIds);
  const unique = new Map<string, ArtifactRow>();
  for (const app of builtApps) {
    const id = `personal:${app.connectionId}`;
    unique.set(id, { kind: "built", id, title: app.title, pinned: pinned.has(app.connectionId), isOwner: app.isOwner === true, app });
  }
  for (const app of savedApps) {
    const id = `saved:${app.view.id}`;
    // Legacy summaries expose management permission, not authorship. Admin
    // access must never turn an unknown author into an ownership claim.
    unique.set(id, { kind: "saved", id, title: app.view.title, pinned: app.onDashboard, isOwner: false, app });
  }
  return [...unique.values()];
}

export function groupArtifacts(rows: readonly ArtifactRow[], search = ""): ArtifactGroup[] {
  const groups: ArtifactGroup[] = [{ title: "Pinned", rows: [] }, { title: "Yours", rows: [] }, { title: "Team", rows: [] }];
  const matching = rows.filter((row) => row.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  for (const group of groups) {
    group.rows = matching.filter((row) => group.title === "Pinned" ? row.pinned : !row.pinned && (group.title === "Yours" ? row.isOwner : !row.isOwner));
    group.rows.sort((left, right) => left.title.localeCompare(right.title));
  }
  return groups;
}

/** Session memory is partitioned by the verified member/org/deployment scope. */
const selectedByScope = new Map<string, string>();
export function readArtifactSelection(scope: string): string | null {
  return selectedByScope.get(scope) ?? null;
}
export function rememberArtifactSelection(scope: string, id: string | null): void {
  if (id === null) selectedByScope.delete(scope);
  else selectedByScope.set(scope, id);
}
export function selectedArtifact(rows: readonly ArtifactRow[], id: string | null): ArtifactRow | null {
  return rows.find((row) => row.id === id) ?? null;
}
