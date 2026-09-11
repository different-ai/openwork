import type { LibraryItem, LibraryPluginItem } from "./library-data";
import { getMcpConnectionsRoute, getNewPluginRoute, getYourConnectionsRoute } from "../../_lib/den-org";

export type LibraryKind = "mcps" | "skills" | "plugins";
export type LibraryState = "ready" | "needs_signin" | "needs_admin_setup" | "needs_setup";
export type LibraryLayout = "grid" | "list";

export const LIBRARY_DEFAULT_KIND: LibraryKind = "mcps";
export const LIBRARY_DEFAULT_STATE: LibraryState = "ready";
export const LIBRARY_LAYOUT_KEY = "openwork:den:library:layout";
export const LIBRARY_KINDS: readonly { value: LibraryKind; label: string }[] = [
  { value: "mcps", label: "MCPs" },
  { value: "skills", label: "Skills" },
  { value: "plugins", label: "Plugins" },
];
export const LIBRARY_STATES: readonly { value: LibraryState; label: string }[] = [
  { value: "ready", label: "Ready to use" },
  { value: "needs_signin", label: "Needs your sign-in" },
  { value: "needs_admin_setup", label: "Needs admin setup" },
  { value: "needs_setup", label: "Needs setup" },
];

export function parseLibraryLayout(value: string | null): LibraryLayout {
  return value === "list" ? "list" : "grid";
}

export function hasLibraryComponent(item: LibraryPluginItem, kind: "skill" | "mcp"): boolean {
  return item.componentKinds.some((value) => value.toLowerCase() === kind);
}

export function getLibraryState(item: LibraryItem): LibraryState {
  if (item.type === "connection") {
    if (item.state === "available") return "needs_setup";
    return item.state === "connected" ? "ready" : item.state;
  }
  if (item.type === "workflow") return item.state;
  return "ready";
}

export function getLibraryKind(item: LibraryItem): LibraryKind {
  if (item.type === "connection") return "mcps";
  if (item.type === "plugin" && hasLibraryComponent(item, "mcp")) return "plugins";
  if (item.type === "plugin" && hasLibraryComponent(item, "skill")) return "skills";
  return "plugins";
}

export function getLibraryFocus(items: readonly LibraryItem[], requestedFocus: string | null) {
  if (!requestedFocus) return null;
  const requested = items.find((item) => `${item.type}-${item.id}` === requestedFocus);
  const item = requested?.type === "workflow"
    ? items.find((candidate) => candidate.type === "plugin" && candidate.id === requested.plugin?.id) ?? requested
    : requested;
  if (!item) return null;
  const kind: LibraryKind = requested?.type === "workflow" ? "plugins" : getLibraryKind(item);
  return { item, kind, state: getLibraryState(item), key: `${item.type}-${item.id}` };
}

export function getLibraryKindItems(items: readonly LibraryItem[], kind: LibraryKind): LibraryItem[] {
  const seen = new Set<string>();
  const pluginIds = new Set(items.filter((item) => item.type === "plugin").map((item) => item.id));
  return items.filter((item) => {
    // Plugin summaries do not establish MCP readiness. Keep bundles in Plugins;
    // only actual member-visible connections (including native ones) go in MCPs.
    const matches = item.type === "connection"
      ? kind === "mcps"
      : item.type === "workflow"
        ? kind === "plugins" && (!item.plugin || !pluginIds.has(item.plugin.id))
        : kind === "plugins" || (kind === "skills" && hasLibraryComponent(item, "skill"));
    const key = `${item.type}-${item.id}`;
    if (!matches || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getLibraryView(items: readonly LibraryItem[], kind: LibraryKind, state: LibraryState, query: string) {
  const kindItems = getLibraryKindItems(items, kind);
  const counts: Record<LibraryState, number> = { ready: 0, needs_signin: 0, needs_admin_setup: 0, needs_setup: 0 };
  for (const item of kindItems) counts[getLibraryState(item)] += 1;
  const tabs = LIBRARY_STATES.filter((tab) => tab.value === "ready" || tab.value === state || counts[tab.value] > 0);
  const activeState = state;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = kindItems.filter((item) => getLibraryState(item) === activeState
    && (!normalizedQuery || item.name.toLowerCase().includes(normalizedQuery) || item.description?.toLowerCase().includes(normalizedQuery)));
  const label = kind === "mcps" ? "MCPs" : kind;
  const empty = normalizedQuery
    ? { title: `No ${label} match your search`, description: "Try a different search or clear it to see this tab.", action: "clear_search" }
    : kindItems.length === 0
      ? {
          title: `No ${label} yet`,
          description: kind === "mcps"
            ? "Connect a cloud MCP to give your agents access to your tools and services."
            : kind === "skills"
              ? "Add reusable instructions for work your agents do often."
              : "Add a plugin to bring related skills and MCPs into your Library.",
          action: "add",
        }
      : activeState === "ready"
        ? {
            title: `No ${label} ready to use`,
            description: counts.needs_signin > 0
              ? "Sign in to your account to start using them."
              : "Setup needs to be completed before you can use them.",
            action: counts.needs_signin > 0 ? "needs_signin" : counts.needs_admin_setup > 0 ? "needs_admin_setup" : "needs_setup",
          }
        : {
            title: `No ${label} need ${activeState === "needs_signin" ? "your sign-in" : activeState === "needs_admin_setup" ? "admin setup" : "setup"}`,
            description: "Check another status tab for your items.",
            action: "ready",
          };
  return { counts, tabs, activeState, visibleItems, empty };
}

export function getLibraryAddAction({ kind, isAdmin, mcpConnections, orgSlug }: {
  kind: LibraryKind;
  isAdmin: boolean;
  mcpConnections: boolean;
  orgSlug: string | null;
}): { label: string; href: string } | null {
  if (kind === "mcps") {
    if (!mcpConnections) return null;
    return isAdmin
      ? { label: "Add MCP", href: getMcpConnectionsRoute(orgSlug) }
      : { label: "View available MCPs", href: getYourConnectionsRoute(orgSlug) };
  }
  // These authoring pages are admin-gated; a member's plugin grant does not
  // grant access to the admin dashboard.
  if (!isAdmin) return null;
  if (kind === "skills") {
    return {
      label: "Create skill",
      href: `${getNewPluginRoute(orgSlug)}?component=skill`,
    };
  }
  return { label: "Add plugin", href: getNewPluginRoute(orgSlug) };
}
