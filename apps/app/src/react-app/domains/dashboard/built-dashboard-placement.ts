import { mcpAppIdSchema } from "@openwork/types/mcp-app";

const placementChangedEvent = "openwork:built-dashboard-placement-changed";

class PlacementChangedEvent extends Event {
  constructor(readonly scope: string, readonly ids: string[]) {
    super(placementChangedEvent);
  }
}

export function readBuiltDashboardApps(scope: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(scope) ?? "[]");
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => mcpAppIdSchema.safeParse(id).success))]
      : [];
  } catch {
    return [];
  }
}

/** Both the dashboard and artifact preview use the existing personal placements. */
export function subscribeBuiltDashboardApps(scope: string, onChange: (ids: string[]) => void) {
  const changed = (event: Event) => {
    if (event instanceof PlacementChangedEvent && event.scope === scope) onChange(event.ids);
  };
  const stored = (event: StorageEvent) => {
    if (event.storageArea === window.localStorage && (event.key === scope || event.key === null)) {
      onChange(readBuiltDashboardApps(scope));
    }
  };
  window.addEventListener(placementChangedEvent, changed);
  window.addEventListener("storage", stored);
  return () => {
    window.removeEventListener(placementChangedEvent, changed);
    window.removeEventListener("storage", stored);
  };
}

export function writeBuiltDashboardApps(scope: string, ids: string[]) {
  try {
    window.localStorage.setItem(scope, JSON.stringify(ids));
  } catch {
    // Keep all mounted views in sync even when local storage is unavailable.
  }
  window.dispatchEvent(new PlacementChangedEvent(scope, ids));
}
