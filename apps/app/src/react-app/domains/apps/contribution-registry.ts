import {
  checkActivation,
  contributionsOfType,
  qualifiedContributionId,
  type AppContribution,
  type AppManifest,
  type InstalledAppRecord,
} from "@openwork/app-contract";

// The contribution registry.
//
// Combines what OpenWork ships with what the user has installed, and decides
// what may currently occupy a place in the interface. Two properties do most of
// the work:
//
//   * **Withdrawal is immediate.** A contribution is derived from state, never
//     registered imperatively, so disabling, uninstalling, quarantining, or
//     revoking a permission removes it on the next render. There is no
//     unregister call to forget.
//   * **Ordering is deterministic.** Built-ins keep their order and come first;
//     installed apps sort by declared order, then app id, then contribution id.
//     Two apps with the same order never swap places between renders.
//
// Registration keys are `<appId>/<contributionId>`. Built-in ids never contain
// a slash, and app ids must contain a dot, so an installed app cannot claim a
// built-in slot or collide with another app.

export type RailItem = {
  /** Globally unique registration key. */
  key: string;
  source: "builtin" | "app";
  /** App id for installed apps; the built-in extension id otherwise. */
  ownerId: string;
  label: string;
  /** Resolved icon reference the shell can render. */
  icon: string;
  tooltip: string | null;
  /** Surface to activate. `null` for built-ins the shell resolves itself. */
  surfaceKey: string | null;
  order: number;
  status: RailStatus | null;
};

export type RailStatus =
  | { kind: "dot"; tone: "neutral" | "active" | "attention" }
  | { kind: "badge"; count: number }
  | { kind: "text"; text: string };

export type BuiltInRailItem = {
  id: string;
  label: string;
  icon: string;
  tooltip?: string;
  order: number;
  /** Built-ins can be hidden by policy or by their own enablement. */
  visible: boolean;
};

export type InstalledApp = {
  record: InstalledAppRecord;
  /** Null when the installed package could not be read; the app contributes nothing. */
  manifest: AppManifest | null;
  /** Live status values the app has set, keyed by contribution id. */
  status?: Record<string, RailStatus | undefined>;
};

/**
 * Whether an installed app may contribute anything at all right now.
 *
 * Deliberately strict: the app must be installed, compatible, set up, enabled,
 * and have a readable manifest. An app that is merely *installed* appears in
 * Preferences and nowhere else.
 */
export function contributesNow(app: InstalledApp): boolean {
  if (!app.manifest) return false;
  return checkActivation(app.record).active;
}

/**
 * A contribution is only honoured while the permission that backs it is still
 * granted. Revoking `desktop.floatingSurface` must take the surface away, not
 * merely stop it from opening.
 */
function permissionSatisfied(app: InstalledApp, contribution: AppContribution): boolean {
  const granted = new Set(app.record.granted_permissions.map((permission) => permission.id));
  switch (contribution.type) {
    case "surface": {
      return contribution.presentation === "floating" ? granted.has("desktop.floatingSurface") : true;
    }
    case "shortcut":
      return contribution.global ? granted.has("desktop.globalShortcut") : true;
    case "background":
      return granted.has("runtime.background.continuous");
    default:
      return true;
  }
}

export function buildRail(builtIns: readonly BuiltInRailItem[], apps: readonly InstalledApp[]): RailItem[] {
  const items: RailItem[] = builtIns
    .filter((entry) => entry.visible)
    .map((entry) => ({
      key: entry.id,
      source: "builtin" as const,
      ownerId: entry.id,
      label: entry.label,
      icon: entry.icon,
      tooltip: entry.tooltip ?? null,
      surfaceKey: null,
      order: entry.order,
      status: null,
    }));

  const contributed: RailItem[] = [];
  for (const app of apps) {
    if (!contributesNow(app) || !app.manifest) continue;
    const surfaces = new Set(
      contributionsOfType(app.manifest.contributions, "surface")
        .filter((surface) => permissionSatisfied(app, surface))
        .map((surface) => surface.id),
    );
    const statuses = contributionsOfType(app.manifest.contributions, "status");

    for (const item of contributionsOfType(app.manifest.contributions, "right_sidebar_item")) {
      // A rail item whose surface is gone — revoked, or never declared — is not
      // rendered as a dead button.
      if (!surfaces.has(item.surface)) continue;
      const status = statuses.find((entry) => entry.target === item.id);
      contributed.push({
        key: qualifiedContributionId(app.record.app_id, item.id),
        source: "app",
        ownerId: app.record.app_id,
        label: item.label,
        icon: `openwork-app://${app.record.app_id}/${item.icon}`,
        tooltip: item.tooltip ?? null,
        surfaceKey: item.surface,
        order: item.order ?? 1_000,
        status: status ? (app.status?.[status.id] ?? null) : null,
      });
    }
  }

  contributed.sort(
    (left, right) =>
      left.order - right.order ||
      left.ownerId.localeCompare(right.ownerId) ||
      left.key.localeCompare(right.key),
  );

  // Built-ins keep their own relative order and stay ahead of installed apps, so
  // installing something never reshuffles the interface a user already knows.
  return [...items.sort((left, right) => left.order - right.order), ...contributed];
}

export type ShortcutRegistration = {
  key: string;
  appId: string;
  shortcutId: string;
  accelerator: string;
  commandId: string;
};

/**
 * Global shortcuts that should currently be registered.
 *
 * A conflict — two apps wanting the same accelerator — is resolved
 * deterministically by app id, and the loser is reported rather than silently
 * dropped, so the UI can tell the user which app did not get its shortcut.
 */
export function resolveShortcuts(apps: readonly InstalledApp[]): {
  registrations: ShortcutRegistration[];
  conflicts: Array<{ accelerator: string; winner: string; losers: string[] }>;
} {
  const wanted: ShortcutRegistration[] = [];
  for (const app of apps) {
    if (!contributesNow(app) || !app.manifest) continue;
    const permission = app.record.granted_permissions.find(
      (entry) => entry.id === "desktop.globalShortcut",
    );
    if (permission?.id !== "desktop.globalShortcut") continue;
    const accelerators = new Map(permission.shortcuts.map((entry) => [entry.id, entry.default_accelerator]));

    for (const shortcut of contributionsOfType(app.manifest.contributions, "shortcut")) {
      if (!shortcut.global) continue;
      const accelerator = accelerators.get(shortcut.id);
      if (!accelerator) continue;
      wanted.push({
        key: qualifiedContributionId(app.record.app_id, shortcut.id),
        appId: app.record.app_id,
        shortcutId: shortcut.id,
        accelerator,
        commandId: shortcut.command,
      });
    }
  }

  wanted.sort((left, right) => left.appId.localeCompare(right.appId) || left.key.localeCompare(right.key));

  const byAccelerator = new Map<string, ShortcutRegistration[]>();
  for (const registration of wanted) {
    const existing = byAccelerator.get(registration.accelerator) ?? [];
    existing.push(registration);
    byAccelerator.set(registration.accelerator, existing);
  }

  const registrations: ShortcutRegistration[] = [];
  const conflicts: Array<{ accelerator: string; winner: string; losers: string[] }> = [];
  for (const [accelerator, group] of byAccelerator) {
    const [winner, ...losers] = group;
    if (!winner) continue;
    registrations.push(winner);
    if (losers.length > 0) {
      conflicts.push({
        accelerator,
        winner: winner.appId,
        losers: losers.map((entry) => entry.appId),
      });
    }
  }

  return { registrations, conflicts };
}

/** Surfaces the runtime should have open for an app, given its current state. */
export function resolveSurfaces(app: InstalledApp): Array<{
  id: string;
  entrypoint: string;
  presentation: "panel" | "floating";
  defaultSize: { width: number; height: number };
  anchor: string | undefined;
  alwaysOnTop: boolean;
}> {
  if (!contributesNow(app) || !app.manifest) return [];
  const alwaysOnTop = app.record.granted_permissions.some(
    (permission) => permission.id === "desktop.floatingSurface" && permission.always_on_top,
  );
  return contributionsOfType(app.manifest.contributions, "surface")
    .filter((surface) => permissionSatisfied(app, surface))
    .map((surface) => {
      const path = app.manifest?.entrypoints.surfaces[surface.entrypoint];
      return path === undefined
        ? null
        : {
            id: surface.id,
            entrypoint: path,
            presentation: surface.presentation,
            defaultSize: surface.default_size,
            anchor: surface.anchor,
            alwaysOnTop: surface.presentation === "floating" && alwaysOnTop,
          };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

/** Hosts an app's session may reach, from its granted permission only. */
export function resolveAllowedHosts(app: InstalledApp): string[] {
  const permission = app.record.granted_permissions.find((entry) => entry.id === "network.host");
  return permission?.id === "network.host" ? [...permission.hosts] : [];
}

export function allowsMicrophone(app: InstalledApp): boolean {
  return app.record.granted_permissions.some((permission) => permission.id === "audio.microphone");
}

/**
 * What the shell should be running, derived entirely from state.
 *
 * The supervisor diffs this against what it has running. Nothing tells it to
 * stop an app; an app simply stops appearing here, which is what makes disable,
 * uninstall, quarantine, and revocation all take effect the same way.
 */
export function resolveRuntimePlan(apps: readonly InstalledApp[]): Map<
  string,
  { allowedHosts: string[]; allowMicrophone: boolean; shortcuts: Array<{ id: string; accelerator: string }> }
> {
  const { registrations } = resolveShortcuts(apps);
  const plan = new Map<
    string,
    { allowedHosts: string[]; allowMicrophone: boolean; shortcuts: Array<{ id: string; accelerator: string }> }
  >();
  for (const app of apps) {
    if (!contributesNow(app)) continue;
    plan.set(app.record.app_id, {
      allowedHosts: resolveAllowedHosts(app),
      allowMicrophone: allowsMicrophone(app),
      shortcuts: registrations
        .filter((entry) => entry.appId === app.record.app_id)
        .map((entry) => ({ id: entry.shortcutId, accelerator: entry.accelerator })),
    });
  }
  return plan;
}
