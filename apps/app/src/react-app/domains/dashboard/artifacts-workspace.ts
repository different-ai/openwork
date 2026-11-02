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

/** Artifacts a member opened stay running so switching back is instant, up to this many. */
export const MAX_RETAINED_ARTIFACTS = 3;

export type RetainedArtifactSlot = { id: string; lastUsed: number };

/**
 * The opened artifacts to keep running, in the order they opened: moving an
 * iframe reloads it, so a kept App never changes place. Past the limit the
 * least recently used one closes. One that leaves the catalog closes too, and
 * nothing stays kept without a selection, so no App starts without being opened.
 */
export function retainArtifacts(
  slots: readonly RetainedArtifactSlot[],
  selectedId: string | null,
  rows: readonly ArtifactRow[],
  limit = MAX_RETAINED_ARTIFACTS,
): readonly RetainedArtifactSlot[] {
  if (!selectedId) return [];
  const kept = slots.filter((slot) => rows.some((row) => row.id === slot.id));
  const newest = Math.max(0, ...kept.map((slot) => slot.lastUsed));
  const selected = kept.find((slot) => slot.id === selectedId);
  if (selected?.lastUsed === newest) return kept;
  if (selected) return kept.map((slot) => slot === selected ? { ...slot, lastUsed: newest + 1 } : slot);
  const oldest = kept.length >= limit ? kept.reduce((left, right) => right.lastUsed < left.lastUsed ? right : left) : null;
  return [...kept.filter((slot) => slot !== oldest), { id: selectedId, lastUsed: newest + 1 }];
}
