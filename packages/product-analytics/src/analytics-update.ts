type UpdateStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Capture = (event: string, properties: Record<string, string | null>) => void;
const PENDING_UPDATE_KEY = "openwork.analytics.pendingUpdate";

export function analyticsVersion(version: string | null | undefined): string | null {
  return version && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

export function createUpdateAnalytics(storage: () => UpdateStorage | undefined, capture: Capture) {
  const offered = new Set<string>();
  let targetVersion: string | null = null;
  let offeredCurrentVersion: string | null = null;
  return {
    offered(current: string | null, target: string | undefined) {
      targetVersion = analyticsVersion(target);
      offeredCurrentVersion = analyticsVersion(current);
      if (!targetVersion || offered.has(targetVersion)) return;
      offered.add(targetVersion);
      capture("update_offered", { current_version: analyticsVersion(current), target_version: targetVersion });
    },
    failed(current: string | null, action: "check" | "download" | "install") {
      capture("update_failed", { current_version: analyticsVersion(current), target_version: targetVersion, reason: `${action}_failed` });
    },
    installing(current: string | null = offeredCurrentVersion, target: string | undefined = targetVersion ?? undefined) {
      const currentVersion = analyticsVersion(current);
      const nextVersion = analyticsVersion(target);
      if (!currentVersion || !nextVersion) return;
      try { storage()?.setItem(PENDING_UPDATE_KEY, JSON.stringify({ currentVersion, nextVersion })); } catch {  }
    },
    cancelInstall() {
      try { storage()?.removeItem(PENDING_UPDATE_KEY); } catch {  }
    },
    launched(current: string | null) {
      const version = analyticsVersion(current);
      if (!version) return;
      try {
        const raw = storage()?.getItem(PENDING_UPDATE_KEY);
        if (!raw) return;
        const pending: unknown = JSON.parse(raw);
        if (pending && typeof pending === "object" && "currentVersion" in pending && "nextVersion" in pending &&
          typeof pending.currentVersion === "string" && pending.nextVersion === version && pending.currentVersion !== version) {
          storage()?.removeItem(PENDING_UPDATE_KEY);
          capture("update_installed", { previous_version: analyticsVersion(pending.currentVersion), current_version: version });
        }
      } catch {  }
    },
  };
}
