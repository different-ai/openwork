/** @jsxImportSource react */
/**
 * Migration prompt — one-time modal that nudges Tauri v0.12.0 users over
 * to the Electron build. Dormant unless the build was produced with
 * `VITE_OPENWORK_MIGRATION_RELEASE=1`, so landing this code on dev has
 * zero user impact until the release script flips that flag.
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";

import {
  deferMigration,
  isMigrationDeferred,
  migrateToElectron,
  writeMigrationSnapshotFromTauri,
} from "../../app/lib/migration";
import { isTauriRuntime } from "../../app/utils";

type MigrationConfig = {
  /**
   * URL template for the Electron artifact on the matching release. The
   * release script substitutes {arch} at build time. On macOS we expect a
   * .zip (the .app bundle is swapped in place — see migrate_to_electron
   * Rust command).
   */
  macUrl?: string;
  /** Optional sha256 check. */
  macSha256?: string;
  /** Windows installer URL. Stub until we wire the Rust path. */
  windowsUrl?: string;
  /** Linux AppImage URL. Stub until we wire the Rust path. */
  linuxUrl?: string;
};

function readBuildTimeConfig(): MigrationConfig | null {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
  const enabled = env.VITE_OPENWORK_MIGRATION_RELEASE === "1";
  if (!enabled) return null;
  return {
    macUrl: env.VITE_OPENWORK_MIGRATION_MAC_URL,
    macSha256: env.VITE_OPENWORK_MIGRATION_MAC_SHA256,
    windowsUrl: env.VITE_OPENWORK_MIGRATION_WINDOWS_URL,
    linuxUrl: env.VITE_OPENWORK_MIGRATION_LINUX_URL,
  };
}

function currentPlatformUrl(cfg: MigrationConfig): { url?: string; sha256?: string } {
  if (typeof navigator === "undefined") return {};
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return { url: cfg.macUrl, sha256: cfg.macSha256 };
  if (ua.includes("windows") || ua.includes("win64") || ua.includes("win32")) {
    return { url: cfg.windowsUrl };
  }
  return { url: cfg.linuxUrl };
}

export function MigrationPrompt(): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<MigrationConfig | null>(null);

  useEffect(() => {
    // Only Tauri shows this modal. Electron users are already on the
    // target runtime.
    if (!isTauriRuntime()) return;
    const cfg = readBuildTimeConfig();
    if (!cfg) return;
    if (isMigrationDeferred()) return;
    setConfig(cfg);
    setOpen(true);
  }, []);

  const handleInstall = useCallback(async () => {
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      const { url, sha256 } = currentPlatformUrl(config);
      if (!url) {
        throw new Error(
          "Automatic migration isn't available for this platform yet. Please upgrade manually from the release page.",
        );
      }
      const snapshot = await writeMigrationSnapshotFromTauri();
      if (!snapshot.ok) {
        throw new Error(
          snapshot.reason ??
            "Failed to capture workspace state before migration.",
        );
      }
      const result = await migrateToElectron({ url, sha256 });
      if (!result.ok) {
        throw new Error(result.reason ?? "Migration handoff failed.");
      }
      // On success, the Rust command kicks off a detached shell script that
      // swaps the .app bundle and relaunches. Tauri will exit on its own
      // shortly — leave the dialog in its loading state until that happens.
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [config]);

  const handleLater = useCallback(() => {
    deferMigration();
    setOpen(false);
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="openwork-migration-title"
    >
      <div className="w-[min(440px,90vw)] rounded-[24px] border border-dls-border bg-dls-surface p-6 shadow-xl">
        <h2
          id="openwork-migration-title"
          className="text-lg font-semibold text-gray-12"
        >
          OpenWork is moving to a new engine
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-gray-11">
          We're upgrading the desktop shell. The install takes ~30 seconds and
          keeps all your workspaces, sessions, and tokens exactly where they
          are. You'll be back in OpenWork automatically when it's done.
        </p>
        {error ? (
          <div className="mt-3 rounded-md border border-red-7/50 bg-red-3 px-3 py-2 text-xs text-red-11">
            {error}
          </div>
        ) : null}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-full px-4 py-2 text-sm text-gray-11 hover:bg-gray-4"
            onClick={handleLater}
            disabled={busy}
          >
            Later
          </button>
          <button
            type="button"
            className="rounded-full bg-gray-12 px-4 py-2 text-sm font-medium text-gray-1 hover:bg-gray-12/90 disabled:opacity-60"
            onClick={handleInstall}
            disabled={busy}
          >
            {busy ? "Installing…" : "Install now"}
          </button>
        </div>
      </div>
    </div>
  );
}
