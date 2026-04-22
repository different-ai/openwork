/** @jsxImportSource react */
import { useEffect } from "react";

import {
  engineInfo,
  engineStart,
  openworkServerInfo,
  orchestratorWorkspaceActivate,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
} from "../../app/lib/desktop";
import { ingestMigrationSnapshotOnElectronBoot } from "../../app/lib/migration";
import { hydrateOpenworkServerSettingsFromEnv, writeOpenworkServerSettings } from "../../app/lib/openwork-server";
import { isDesktopRuntime, isElectronRuntime, safeStringify } from "../../app/utils";
import { useServer } from "../kernel/server-provider";
import { useBootState } from "./boot-state";

// Module-scoped latch so React Strict-Mode's "mount-unmount-remount" cycle in
// dev only triggers the boot sequence once per app launch, and the async work
// keeps running across the transient unmount.
let BOOT_STARTED = false;

/**
 * On desktop (Tauri) startup:
 *   1) bootstrap the workspace list
 *   2) if a local workspace is selected, restart the embedded OpenWork server
 *   3) start the OpenCode engine pointed at the workspace
 *   4) activate the workspace in the orchestrator
 *   5) persist the resulting base URL + token into local OpenWork settings so the
 *      React routes (session-route / settings-route) see a live `readOpenworkServerSettings()`
 *
 * Safe to call multiple times — gated by a `didBoot` ref so it runs once per mount.
 */
export function useDesktopRuntimeBoot() {
  const { setPhase, setError, markReady } = useBootState();
  const { setActive } = useServer();

  useEffect(() => {
    if (!isDesktopRuntime()) {
      // Web/headless: nothing to spawn, we're instantly "ready".
      markReady();
      return;
    }
    if (BOOT_STARTED) return;
    BOOT_STARTED = true;

    void (async () => {
      try {
        // On Electron specifically: if the previous Tauri install dropped
        // a migration snapshot, fold it into localStorage before any of
        // the boot code reads workspace preferences. Idempotent across
        // launches (the helper only writes keys that are still empty
        // and acks the file after ingestion).
        if (isElectronRuntime()) {
          const hydrated = await ingestMigrationSnapshotOnElectronBoot();
          if (hydrated > 0) {
            // eslint-disable-next-line no-console -- valuable one-time signal
            console.info(`[migration] hydrated ${hydrated} localStorage keys from Tauri snapshot`);
          }
        }
        hydrateOpenworkServerSettingsFromEnv();

        setPhase("bootstrapping-workspaces");
        const list = await workspaceBootstrap().catch(() => null);
        if (!list) {
          markReady();
          return;
        }

        const selectedId = resolveWorkspaceListSelectedId(list);
        const workspace = selectedId
          ? list.workspaces.find((w) => w.id === selectedId)
          : undefined;
        if (!workspace || workspace.workspaceType === "remote") {
          markReady();
          return;
        }

        const workspaceRoot = workspace.path?.trim();
        if (!workspaceRoot) {
          markReady();
          return;
        }

        // FAST PATH ─────────────────────────────────────────────────────
        // Cheap status probe: if engine is already running just publish the
        // current openwork-server base URL + token and finish in <1s.
        // This mirrors Solid's bootstrap at context/workspace.ts:3883-3907
        // ("localAttachExisting"), which never restarts a running stack.
        try {
          const engine = await engineInfo();
          if (engine?.running && engine.baseUrl) {
            setActive(engine.baseUrl);
            const fresh = await openworkServerInfo().catch(() => null);
            if (fresh?.baseUrl) {
              writeOpenworkServerSettings({
                urlOverride: fresh.baseUrl,
                token:
                  fresh.ownerToken?.trim() ||
                  fresh.clientToken?.trim() ||
                  undefined,
                portOverride: fresh.port ?? undefined,
                remoteAccessEnabled: fresh.remoteAccessEnabled === true,
              });
              try {
                window.dispatchEvent(
                  new CustomEvent("openwork-server-settings-changed"),
                );
              } catch {
                /* ignore */
              }
            }
            markReady();
            return;
          }
        } catch {
          // engineInfo is best-effort; fall through to the slow path.
        }

        // SLOW PATH ─────────────────────────────────────────────────────
        // No running engine. engine_start handles both orchestrator spawn
        // and openwork-server (re)start with --opencode-base-url attached,
        // so we don't need a separate openworkServerRestart step.
        const localPaths = list.workspaces
          .filter((entry) => entry.workspaceType !== "remote")
          .map((entry) => entry.path?.trim() ?? "")
          .filter((path): path is string => path.length > 0);
        const workspacePaths = [workspaceRoot];
        for (const path of localPaths) {
          if (!workspacePaths.includes(path)) workspacePaths.push(path);
        }

        setPhase("starting-engine", "Launching the OpenCode engine");
        const engineStartResult = await engineStart(workspaceRoot, {
          runtime: "openwork-orchestrator",
          workspacePaths,
        }).catch((error) => {
          console.warn("[desktop-boot] engineStart failed:", error);
          setError(error instanceof Error ? error.message : safeStringify(error));
          return null;
        });

        if (engineStartResult) {
          if (engineStartResult.baseUrl) {
            setActive(engineStartResult.baseUrl);
          }
          try {
            const freshInfo = await openworkServerInfo();
            if (freshInfo?.baseUrl) {
              writeOpenworkServerSettings({
                urlOverride: freshInfo.baseUrl,
                token:
                  freshInfo.ownerToken?.trim() ||
                  freshInfo.clientToken?.trim() ||
                  undefined,
                portOverride: freshInfo.port ?? undefined,
                remoteAccessEnabled: freshInfo.remoteAccessEnabled === true,
              });
              try {
                window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
              } catch {
                /* ignore */
              }
            }
          } catch (error) {
            console.warn("[desktop-boot] post-engineStart openworkServerInfo failed:", error);
          }
        }

        setPhase("activating-workspace", workspace.displayName || workspace.name || workspaceRoot);
        await orchestratorWorkspaceActivate({
          workspacePath: workspaceRoot,
          name: workspace.name ?? workspace.displayName ?? null,
        }).catch((error) => {
          console.warn("[desktop-boot] orchestratorWorkspaceActivate failed:", error);
        });

        markReady();
      } catch (error) {
        console.warn("[desktop-boot] fatal:", error);
        setError(error instanceof Error ? error.message : safeStringify(error));
      }
    })();
  }, [markReady, setActive, setError, setPhase]);
}

/**
 * Component wrapper that must be rendered inside <BootStateProvider>. It runs
 * the boot hook exactly once per app mount so callers don't have to think
 * about React Strict-Mode double-invocation.
 */
export function DesktopRuntimeBoot(): null {
  useDesktopRuntimeBoot();
  return null;
}
