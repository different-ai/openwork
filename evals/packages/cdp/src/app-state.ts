import { evaluate } from "./cdp.ts";
import type { CdpClient, EvaluateOptions } from "./cdp.ts";

/**
 * Readiness of the OpenWork desktop is defined by the UI being *interactive*,
 * not by the route matching an allowlist: a fresh profile with no workspace
 * legitimately sits on `/session` offering "Create or connect a workspace",
 * and a workspace can be selected while the panel still renders placeholders.
 *
 * This module is the single implementation of that predicate so the lifecycle
 * layer (@openwork/hosts) and the behaviours specs call (@openwork/behaviors)
 * cannot drift apart. It lives in @openwork/cdp because both already depend on
 * it, which keeps the dependency graph acyclic.
 */

/** Copy the app renders while it is still settling (from apps/app/src/i18n/locales/en.ts). */
export const APP_TRANSITIONAL_TEXTS = [
  "Preparing workspace",
  "Connecting signed-in services",
  "Connecting services",
  "Loading available resources",
  "Loading tasks",
  "Pulling in the latest messages",
] as const;

export type AppSurfaceState = "welcome" | "workspace" | "no-workspace";

export interface AppStateProbe {
  /** The automation control API is registered. */
  controlReady: boolean;
  /** The transitional message currently on screen, if any. */
  transitional: string | null;
  /** Which interactive surface is showing, or null while nothing is usable yet. */
  surface: AppSurfaceState | null;
  workspaceId: string | null;
  route: string;
  /** First 300 characters of visible text, for self-diagnosing failures. */
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function surfaceOrNull(value: unknown): AppSurfaceState | null {
  return value === "welcome" || value === "workspace" || value === "no-workspace" ? value : null;
}

export function parseAppStateProbe(value: unknown): AppStateProbe {
  if (!isRecord(value)) {
    return { controlReady: false, transitional: null, surface: null, workspaceId: null, route: "", text: "" };
  }
  return {
    controlReady: value.controlReady === true,
    transitional: stringOrNull(value.transitional),
    surface: surfaceOrNull(value.surface),
    workspaceId: stringOrNull(value.workspaceId),
    route: typeof value.route === "string" ? value.route : "",
    text: typeof value.text === "string" ? value.text : "",
  };
}

/**
 * The app is usable: control registered and a surface a user can act on.
 *
 * Transitional copy only disqualifies the workspace surfaces. The welcome screen
 * legitimately shows progress ("Preparing workspace") for a background step
 * while its own buttons remain perfectly clickable, and treating that as
 * not-ready waits forever for something that is not blocking the user.
 */
export function isInteractive(probe: AppStateProbe): boolean {
  if (!probe.controlReady || probe.surface === null) return false;
  if (probe.surface === "welcome") return true;
  return probe.transitional === null;
}

export function describeAppState(probe: AppStateProbe): string {
  const blocker = probe.transitional ? `still showing ${JSON.stringify(probe.transitional)}` : "no interactive surface";
  return `route ${probe.route || "<unknown>"}, ${probe.controlReady ? "control ready" : "control missing"}, ${blocker}. Visible text: ${JSON.stringify(probe.text)}`;
}

const PROBE_EXPRESSION = `(() => {
  const text = document.body?.innerText ?? "";
  const route = window.location.hash.replace(/^#/, "") || window.location.pathname;
  const transitional = ${JSON.stringify([...APP_TRANSITIONAL_TEXTS])}
    .find((message) => text.includes(message)) ?? null;
  const buttonLabels = [...document.querySelectorAll("button")].map((button) => (button.textContent ?? "").trim());
  const taskUi = text.includes("What do you need done?") || buttonLabels.includes("Run task");
  const needsWorkspace = text.includes("Create or connect a workspace");
  const welcome = text.includes("Welcome to OpenWork");
  // The product's own active-workspace state; the route is only a fallback
  // because a selected workspace does not always appear in the hash.
  const stored = localStorage.getItem("openwork.react.activeWorkspace");
  const routeMatch = (route.match(/\\/workspace\\/([^/?#]+)/) ?? [])[1] ?? null;
  const workspaceId = (stored && stored.length > 0 ? stored : null) ?? routeMatch;
  // Any settings/extensions surface inside a workspace is interactive too.
  const settingsSurface = /\\/workspace\\/[^/?#]+\\/(settings|extensions)/.test(route)
    && (text.includes("Extensions") || text.includes("Preferences") || text.includes("Permissions"));
  const surface = welcome
    ? "welcome"
    : (taskUi || settingsSurface) && workspaceId && !needsWorkspace
      ? "workspace"
      : taskUi || needsWorkspace
        ? "no-workspace"
        : null;
  return {
    controlReady: Boolean(window.__openworkControl),
    transitional,
    surface,
    // Report the id whenever the app knows one, even while the welcome surface
    // is showing: onboarding selects a workspace before it leaves that screen.
    workspaceId,
    route,
    text: text.slice(0, 300),
  };
})()`;

export async function probeAppState(client: CdpClient, opts: EvaluateOptions = {}): Promise<AppStateProbe> {
  return parseAppStateProbe(await evaluate(client, PROBE_EXPRESSION, opts));
}

/** The product's active workspace id, read from its own state. */
export async function readActiveWorkspaceId(client: CdpClient, opts: EvaluateOptions = {}): Promise<string | null> {
  return (await probeAppState(client, opts)).workspaceId;
}
