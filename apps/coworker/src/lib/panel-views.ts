/**
 * The right panel's three views and the levels inside them. Activity holds
 * what the coworker is doing and, one level down, its Documents, Workers, and
 * Assignments; Coworker settings holds the coworker's own settings and, one
 * level down, Apps & tools with its own levels beneath. Pure, so the strip
 * order, the level names, and every deep link are unit-tested.
 */
import { APPS_TOOLS_TITLE } from "./apps-tools.ts";
import { rootRoute, withPath, type PanelCrumb, type PanelRoute } from "./panel-route.ts";

export type PanelView = "overview" | "memory" | "settings";

/** The strip, top to bottom. */
export const PANEL_VIEWS: readonly PanelView[] = ["overview", "memory", "settings"];

export const PANEL_VIEW_TITLES: Record<PanelView, string> = {
  overview: "Activity",
  memory: "Memory",
  settings: "Coworker settings",
};

export function isPanelView(value: string): value is PanelView {
  return PANEL_VIEWS.some((view) => view === value);
}

/** The levels under Activity. */
export const ACTIVITY_CRUMBS = {
  documents: { id: "documents", title: "Documents" },
  workers: { id: "workers", title: "Workers" },
  assignments: { id: "assignments", title: "Assignments" },
} as const satisfies Record<string, PanelCrumb>;

export type ActivityLevel = keyof typeof ACTIVITY_CRUMBS;

export const ACTIVITY_LEVELS: readonly ActivityLevel[] = ["documents", "workers", "assignments"];

export type ActivityScreen = { kind: "root" } | { kind: ActivityLevel };

/** Which screen the Activity view shows for a path: the first crumb decides; anything unknown is the root. */
export function activityScreen(path: readonly PanelCrumb[]): ActivityScreen {
  const first = path[0];
  if (!first) return { kind: "root" };
  const level = ACTIVITY_LEVELS.find((candidate) => ACTIVITY_CRUMBS[candidate].id === first.id);
  return level ? { kind: level } : { kind: "root" };
}

export function activityRoute(level: ActivityLevel): PanelRoute<PanelView> {
  return withPath(rootRoute<PanelView>("overview"), [ACTIVITY_CRUMBS[level]]);
}

/** The first row of Coworker settings, and the level Apps & tools lives under. */
export const APPS_TOOLS_CRUMB: PanelCrumb = { id: "apps-tools", title: APPS_TOOLS_TITLE };

export type SettingsScreen = { kind: "root" } | { kind: "apps-tools"; path: PanelCrumb[] };

/** Which screen Coworker settings shows: its own rows, or Apps & tools with the levels below it. */
export function settingsScreen(path: readonly PanelCrumb[]): SettingsScreen {
  const first = path[0];
  if (!first || first.id !== APPS_TOOLS_CRUMB.id) return { kind: "root" };
  return { kind: "apps-tools", path: path.slice(1) };
}

/** A route into Apps & tools from anywhere: a receipt's tool, a search result, the beside column folding back. */
export function appsToolsRoute(path: readonly PanelCrumb[] = []): PanelRoute<PanelView> {
  return withPath(rootRoute<PanelView>("settings"), [APPS_TOOLS_CRUMB, ...path]);
}

/** The levels below Apps & tools in a settings route; empty at Apps & tools itself or outside it. */
export function appsToolsPath(route: PanelRoute): PanelCrumb[] {
  const screen = settingsScreen(route.path);
  return screen.kind === "apps-tools" ? screen.path : [];
}

/** The route key prefix a column beside the conversation reports for an Apps & tools detail. */
export function appsToolsRouteKey(path: readonly PanelCrumb[]): string {
  return ["settings", APPS_TOOLS_CRUMB.id, ...path.map((crumb) => crumb.id)].join("/");
}
