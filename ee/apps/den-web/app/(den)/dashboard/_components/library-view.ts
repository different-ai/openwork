import { firstName, joinNames } from "./access-summary";
import type { LibraryAccessEdge, LibraryItem } from "./library-data";

export type LibraryFilter = "all" | "connectors" | "skills" | "plugins" | "workflows" | "models";

export const LIBRARY_FILTERS: readonly { value: LibraryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "connectors", label: "Connectors" },
  { value: "skills", label: "Skills" },
  { value: "plugins", label: "Plugins" },
  { value: "workflows", label: "Workflows" },
  { value: "models", label: "Models" },
];

export function parseLibraryFilter(value: string | null): LibraryFilter {
  return LIBRARY_FILTERS.find((entry) => entry.value === value)?.value ?? "all";
}

export const NEEDS_SIGN_IN_STATUS = "needs-sign-in";

export function needsViewerSignIn(item: LibraryItem): boolean {
  return item.type === "connection" && item.state === "needs_signin";
}

export function parseNeedsSignIn(value: string | null): boolean {
  return value === NEEDS_SIGN_IN_STATUS;
}

export function isSingleSkill(item: LibraryItem): boolean {
  return item.type === "plugin"
    && item.componentCount === 1
    && item.componentKinds.length > 0
    && item.componentKinds.every((kind) => kind.toLowerCase() === "skill");
}

export function isWorkflowOnlyPlugin(item: LibraryItem): boolean {
  return item.type === "plugin"
    && item.componentKinds.length > 0
    && item.componentKinds.every((kind) => kind.toLowerCase() === "workflow" || kind.toLowerCase() === "script");
}

export function libraryFilterOf(item: LibraryItem): Exclude<LibraryFilter, "all" | "models"> {
  if (item.type === "connection") return "connectors";
  if (item.type === "plugin") return isSingleSkill(item) ? "skills" : "plugins";
  return "workflows";
}

export function workflowLastRunFailed(item: LibraryItem): item is Extract<LibraryItem, { type: "workflow" }> {
  return item.type === "workflow" && item.resultState === "needs_attention";
}

export function workflowFailureSummary(reason: string | null | undefined): string {
  const text = reason?.trim() ?? "";
  if (!text) return "Open it to see what went wrong";
  const lower = text.toLowerCase();
  if (/(needs_signin|needs_connection|connection_not_connected|reconnect|sign[- ]?in|unauthori[sz]ed|invalid_grant|401)/.test(lower)) return "A connection needs you to sign in again";
  if (/(capability_unavailable|not available|forbidden|403|permission)/.test(lower)) return "It uses something you no longer have access to";
  if (/(timed? ?out|timeout|deadline)/.test(lower)) return "It took too long and stopped";
  if (/(rate.?limit|429|too many requests)/.test(lower)) return "A service asked it to slow down. Try again soon";
  if (/(output|schema).*(invalid|mismatch|did not match)|invalid.*(output|schema)/.test(lower)) return "Its result didn't have the expected shape";
  if (text.length <= 90 && !/[{}[\]<>_]|error:|exception|stack|uncaught|undefined|null\b|line \d+|col(?:umn)? \d+|property|is not a function|non-object/i.test(text)) return text.replace(/\.$/, "");
  return "Open it to see what went wrong";
}

export function isOwnedByViewer(item: LibraryItem, viewerId: string | null, ownedConnectionIds: ReadonlySet<string>): boolean {
  if (item.edges.some((edge) => edge.kind === "mine")) return true;
  if (item.type !== "connection") return false;
  if (ownedConnectionIds.has(item.id)) return true;
  return viewerId !== null && item.edges.some((edge) => edge.kind === "person" && edge.sharedBy?.orgMembershipId === viewerId);
}

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
    if (isWorkflowOnlyPlugin(item)) return false;
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

export function libraryKindLabel(item: LibraryItem): string {
  if (item.type === "connection") return "Connector";
  if (item.type === "workflow") return "Workflow";
  return isSingleSkill(item) ? "Skill" : "Plugin";
}

export function libraryItemReady(item: LibraryItem): boolean {
  if (item.type === "connection") return item.state === "connected";
  if (item.type === "workflow") return item.state === "ready";
  return true;
}
