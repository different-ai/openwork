import { captureAnalyticsEvent, type AnalyticsProperties } from "./analytics";
import type { EngineV2PreviewStatus } from "./openwork-server";
import { isDesktopRuntime } from "./runtime-env";

const STORAGE_KEY = "openwork.engine-migration.analytics.v1";
const MAX_RECEIPTS = 256;
export type EngineMigrationAnalyticsStatus = EngineV2PreviewStatus & { engineChangedAt?: string | number };
type StorageAccess = Pick<Storage, "getItem" | "setItem">;

function localStorageAccess(): StorageAccess | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

function errorCategory(error: string | undefined): string {
  if (/not enough.*(?:disk|space)|disk.*(?:full|space)|ENOSPC/i.test(error ?? "")) return "insufficient_disk_space";
  if (/interrupt|abort|stopped|cancel/i.test(error ?? "")) return "migration_interrupted";
  if (/timeout|timed out/i.test(error ?? "")) return "migration_timeout";
  if (/unreachable|ECONNREFUSED|engine.*not.*running/i.test(error ?? "")) return "engine_unavailable";
  return "migration_failed";
}

/** Same product-analytics channel and consent controls on desktop and web. */
export function createEngineMigrationAnalyticsObserver(options: {
  capture: (event: string, properties: AnalyticsProperties) => void;
  surface: "desktop" | "web";
  appVersion: string;
  storage?: StorageAccess;
  engineChanged?: () => void;
}) {
  const seen = new Set<string>();
  const engines = new Map<string, "v1" | "v2">();
  try {
    const raw: unknown = JSON.parse(options.storage?.getItem(STORAGE_KEY) ?? "null");
    if (Array.isArray(raw)) for (const key of raw.slice(-MAX_RECEIPTS)) if (typeof key === "string") seen.add(key);
  } catch { /* Private browsing or corrupt receipts must not break the app. */ }

  return (baseUrl: string, status: EngineMigrationAnalyticsStatus): void => {
    const instance = baseUrl.replace(/\/+$/, "");
    const engine = status.enabled && status.chatRouting ? "v2" : "v1";
    const previous = engines.get(instance);
    engines.set(instance, engine);
    if (previous && previous !== engine) options.engineChanged?.();
    const migration = status.migration;
    if (!migration) return;
    const origin = status.forceUpgradePending ? "forced" : status.engineOrigin ?? "manual";
    const routingReceipt = origin === "fresh" || origin === "reverted";
    let event: string;
    let receipt: string;
    const properties: AnalyticsProperties = { surface: options.surface, appVersion: options.appVersion, origin };
    if (routingReceipt && !status.forceUpgradePending && migration.state !== "running" && (migration.state !== "error" || origin === "reverted")) {
      event = "migration_completed";
      receipt = `routing:${origin}:${status.engineChangedAt ?? "initial"}`;
      Object.assign(properties, { imported: 0, skipped: 0, notCopied: 0, trimmed: 0 });
    } else {
      if (migration.state === "idle") return;
      event = migration.state === "running" ? "migration_started" : migration.state === "completed" ? "migration_completed" : "migration_failed";
      receipt = `copy:${migration.startedAt ?? "legacy"}:${event}`;
      if (migration.state === "completed") {
        Object.assign(properties, {
          imported: Math.max(0, Math.trunc(migration.imported)), skipped: Math.max(0, Math.trunc(migration.skipped)),
          notCopied: migration.notCopied?.length ?? 0, trimmed: migration.trimmed?.length ?? 0,
        });
      } else if (migration.state === "error") properties.error = errorCategory(migration.error);
    }
    // Endpoint identity stays local: never include it, paths, titles, ids, or raw errors in analytics.
    const key = JSON.stringify([instance, receipt]);
    if (seen.has(key)) return;
    seen.add(key);
    while (seen.size > MAX_RECEIPTS) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
    }
    try { options.storage?.setItem(STORAGE_KEY, JSON.stringify([...seen])); } catch { /* Memory dedupe still works. */ }
    try { options.capture(event, properties); } catch { /* Analytics is always best effort. */ }
  };
}

let observer: ReturnType<typeof createEngineMigrationAnalyticsObserver> | undefined;

export function observeEngineMigrationAnalytics(baseUrl: string, status: EngineMigrationAnalyticsStatus): void {
  observer ??= createEngineMigrationAnalyticsObserver({
    capture: captureAnalyticsEvent,
    surface: isDesktopRuntime() ? "desktop" : "web",
    appVersion: String(import.meta.env.VITE_OPENWORK_APP_VERSION ?? "").trim() || "unknown",
    storage: localStorageAccess(),
    engineChanged: () => {
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("openwork-engine-changed"));
    },
  });
  observer(baseUrl, status);
}
