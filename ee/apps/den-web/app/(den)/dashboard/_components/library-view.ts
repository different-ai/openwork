import { firstName, joinNames } from "./access-summary";
import type { LibraryAccessEdge, LibraryItem } from "./library-data";

export type LibraryFilter = "all" | "connectors" | "skills" | "plugins" | "models";

export const LIBRARY_FILTERS: readonly { value: LibraryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "connectors", label: "Connectors" },
  { value: "skills", label: "Skills" },
  { value: "plugins", label: "Plugins" },
  { value: "models", label: "Models" },
];

export function parseLibraryFilter(value: string | null): LibraryFilter {
  return LIBRARY_FILTERS.find((entry) => entry.value === value)?.value ?? "all";
}

/** `?status=needs-sign-in` narrows the Library to what waits on the viewer. */
export const NEEDS_SIGN_IN_STATUS = "needs-sign-in";

/** A connector the viewer still has to sign in to before they can use it. */
export function needsViewerSignIn(item: LibraryItem): boolean {
  return item.type === "connection" && item.state === "needs_signin";
}

export function parseNeedsSignIn(value: string | null): boolean {
  return value === NEEDS_SIGN_IN_STATUS;
}

/** A plugin made of one skill is a skill to the person using it. */
export function isSingleSkill(item: LibraryItem): boolean {
  return item.type === "plugin"
    && item.componentCount === 1
    && item.componentKinds.length > 0
    && item.componentKinds.every((kind) => kind.toLowerCase() === "skill");
}

export function libraryFilterOf(item: LibraryItem): Exclude<LibraryFilter, "all"> | null {
  if (item.type === "connection") return "connectors";
  if (item.type === "plugin") return isSingleSkill(item) ? "skills" : "plugins";
  return null;
}

/**
 * Something is the viewer's when they made it. Den marks plugins the viewer
 * created as "mine", and a connector the viewer added comes back with its
 * access list, which Den only returns to the person who added it.
 */
export function isOwnedByViewer(item: LibraryItem, viewerId: string | null, ownedConnectionIds: ReadonlySet<string>): boolean {
  if (item.edges.some((edge) => edge.kind === "mine")) return true;
  if (item.type !== "connection") return false;
  if (ownedConnectionIds.has(item.id)) return true;
  return viewerId !== null && item.edges.some((edge) => edge.kind === "person" && edge.sharedBy?.orgMembershipId === viewerId);
}

/** Where something the organization gave the viewer came from, in a few words. */
export function receivedStatus(edges: readonly LibraryAccessEdge[]): string {
  if (edges.some((edge) => edge.kind === "org_wide")) return "Everyone";
  const teams = edges.flatMap((edge) => edge.kind === "team" ? [edge.team.name] : []);
  if (teams.length > 0) return joinNames(teams);
  const sharer = edges.find((edge) => edge.kind === "person" && edge.sharedBy);
  if (sharer?.kind === "person" && sharer.sharedBy) return `From ${firstName(sharer.sharedBy.name)}`;
  return "Your organization";
}

export type LibraryGroups = {
  mine: LibraryItem[];
  received: LibraryItem[];
  total: number;
};

export function groupLibrary(input: {
  items: readonly LibraryItem[];
  filter: LibraryFilter;
  query: string;
  isMine: (item: LibraryItem) => boolean;
  needsSignIn?: boolean;
}): LibraryGroups {
  const needle = input.query.trim().toLowerCase();
  const seen = new Set<string>();
  const visible = input.items.filter((item) => {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (input.filter !== "all" && libraryFilterOf(item) !== input.filter) return false;
    if (input.needsSignIn && !needsViewerSignIn(item)) return false;
    if (!needle) return true;
    return `${item.name} ${item.description ?? ""}`.toLowerCase().includes(needle);
  });
  const byName = (left: LibraryItem, right: LibraryItem) => left.name.localeCompare(right.name);
  return {
    mine: visible.filter(input.isMine).sort(byName),
    received: visible.filter((item) => !input.isMine(item)).sort(byName),
    total: input.items.length,
  };
}

export function libraryItemDescription(item: LibraryItem): string {
  const text = item.description?.split(/\s[—–-]\s|—/)[0]?.trim();
  if (text) return text.replace(/\.$/, "");
  if (item.type === "connection") return "Connector";
  if (item.type === "workflow") return "Workflow";
  return isSingleSkill(item) ? "Skill" : "Plugin";
}

/** What a row reads as in its Kind column. */
export function libraryKindLabel(item: LibraryItem): string {
  if (item.type === "connection") return "Connector";
  if (item.type === "workflow") return "Workflow";
  return isSingleSkill(item) ? "Skill" : "Plugin";
}

/** Ready to use right now: a connector you are signed in to, any plugin, a runnable workflow. */
export function libraryItemReady(item: LibraryItem): boolean {
  if (item.type === "connection") return item.state === "connected";
  if (item.type === "workflow") return item.state === "ready";
  return true;
}
