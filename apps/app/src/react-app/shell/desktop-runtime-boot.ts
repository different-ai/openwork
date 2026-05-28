/** @jsxImportSource react */
import { useEffect } from "react";

import {
  engineInfo,
  engineStart,
  openworkServerInfo,
  openworkServerRestart,
  resolveWorkspaceListSelectedId,
  runtimeBootstrap,
  workspaceBootstrap,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  type EngineInfo,
  type OpenworkServerInfo,
  type WorkspaceInfo,
  type WorkspaceList,
} from "../../app/lib/desktop";
import { ingestMigrationSnapshotOnElectronBoot } from "../../app/lib/migration";
import {
  hydrateOpenworkServerSettingsFromEnv,
  readOpenworkServerSettings,
  writeOpenworkServerSettings,
} from "../../app/lib/openwork-server";
import { isDesktopRuntime, isElectronRuntime, safeStringify } from "../../app/utils";
import { useServer } from "../kernel/server-provider";
import { useBootState } from "./boot-state";

// Module-scoped latch so React Strict-Mode's "mount-unmount-remount" cycle in
// dev only triggers the boot sequence once per app launch, and the async work
// keeps running across the transient unmount.
let BOOT_STARTED = false;

type BootOpenworkServerInfo = {
  running?: boolean | null;
  baseUrl?: string | null;
  ownerToken?: string | null;
  clientToken?: string | null;
  hostToken?: string | null;
  port?: number | null;
  remoteAccessEnabled?: boolean;
};

function isOpenworkServerInfoLike(info: unknown): info is BootOpenworkServerInfo {
  return typeof info === "object" && info !== null;
}

function isOpenworkServerReady(info?: BootOpenworkServerInfo) {
  return Boolean(
    info?.running === true &&
      info.baseUrl?.trim() &&
      (info.ownerToken?.trim() || info.clientToken?.trim()),
  );
}

/**
 * On desktop (Tauri) startup:
 *   1) bootstrap the workspace list
 *   2) if a local workspace is selected, restart the embedded OpenWork server
 *   3) start the OpenCode engine pointed at the workspace
 *   4) activate the workspace on the running OpenWork server
 *   5) notify React routes that fresh desktop runtime info is available. Electron
 *      routes read live runtime info directly instead of persisting ephemeral
 *      localhost ports/tokens into OpenWork settings.
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
        const preferredRemoteAccess = readOpenworkServerSettings().remoteAccessEnabled === true;

        const publishOpenworkServerInfo = (serverInfo: BootOpenworkServerInfo | null | undefined) => {
          if (!serverInfo?.baseUrl) return;
          writeOpenworkServerSettings({
            urlOverride: serverInfo.baseUrl,
            token:
              serverInfo.ownerToken?.trim() ||
              serverInfo.clientToken?.trim() ||
              undefined,
            hostToken: serverInfo.hostToken?.trim() || undefined,
            portOverride: serverInfo.port ?? undefined,
            remoteAccessEnabled: serverInfo.remoteAccessEnabled === true,
          });
          try {
            window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
          } catch {
            /* ignore */
          }
        };

        const startServerWithoutDesktopWorkspace = async () => {
          setPhase("starting-engine", "Starting OpenWork server");
          const serverInfo = await openworkServerRestart({ remoteAccessEnabled: preferredRemoteAccess }).catch((error) => {
            console.warn("[desktop-boot] openworkServerRestart failed:", error);
            return null;
          });
          if (!isOpenworkServerInfoLike(serverInfo) || !isOpenworkServerReady(serverInfo)) {
            setError("OpenWork server did not finish starting. Please restart OpenWork.");
            return;
          }
          publishOpenworkServerInfo(serverInfo);
          markReady();
        };

        setPhase("bootstrapping-workspaces");
        const list = await workspaceBootstrap().catch(() => null) as WorkspaceList | null;
        if (!list) {
          await startServerWithoutDesktopWorkspace();
          return;
        }

        const selectedId = resolveWorkspaceListSelectedId(list);
        const workspace = selectedId
          ? list.workspaces.find((w) => w.id === selectedId)
          : undefined;
        if (!workspace || workspace.workspaceType === "remote") {
          await startServerWithoutDesktopWorkspace();
          return;
        }

        const workspaceRoot = workspace.path?.trim();
        if (!workspaceRoot) {
          await startServerWithoutDesktopWorkspace();
          return;
        }

        if (isElectronRuntime()) {
          setPhase("starting-engine", "Starting your workspace");
          const boot = (await runtimeBootstrap().catch((error) => ({
            ok: false,
            error: error instanceof Error ? error.message : safeStringify(error),
          }))) as {
            ok?: boolean;
            skipped?: boolean;
            error?: string;
            engine?: { baseUrl?: string | null };
            openworkServer?: BootOpenworkServerInfo;
          };

          if (boot.ok === false) {
            setError(boot.error || "Failed to start OpenWork runtime");
            return;
          }

          if (!boot.skipped && !isOpenworkServerReady(boot.openworkServer)) {
            setError("OpenWork server did not finish starting. Please restart OpenWork.");
            return;
          }

          if (boot.engine?.baseUrl) {
            setActive(boot.engine.baseUrl);
          }
          let serverInfo = boot.openworkServer;
          if (preferredRemoteAccess && serverInfo?.remoteAccessEnabled !== true) {
            const restarted = await openworkServerRestart({ remoteAccessEnabled: true }).catch((error) => {
              console.warn("[desktop-boot] openworkServerRestart failed:", error);
              return null;
            });
            if (isOpenworkServerInfoLike(restarted)) serverInfo = restarted;
          }
          publishOpenworkServerInfo(serverInfo);
          markReady();
          return;
        }

        // FAST PATH ─────────────────────────────────────────────────────
        // Cheap status probe: if engine is already running just publish the
        // current openwork-server base URL + token and finish in <1s.
        // This mirrors Solid's bootstrap at context/workspace.ts:3883-3907
        // ("localAttachExisting"), which never restarts a running stack.
        try {
          const engine = await engineInfo() as EngineInfo | null;
          if (engine?.running && engine.baseUrl) {
            setActive(engine.baseUrl);
            const fresh = await openworkServerInfo().catch(() => null) as OpenworkServerInfo | null;
            if (fresh?.baseUrl) {
              writeOpenworkServerSettings({
                urlOverride: fresh.baseUrl,
                token:
                  fresh.ownerToken?.trim() ||
                  fresh.clientToken?.trim() ||
                  undefined,
                hostToken: fresh.hostToken?.trim() || undefined,
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
        // No running engine. Tauri now mirrors Electron: engine_start boots
        // openwork-server and lets that server manage OpenCode.
        const localPaths = list.workspaces.flatMap((entry: WorkspaceInfo) => {
          const path = entry.workspaceType !== "remote" ? entry.path?.trim() ?? "" : "";
          return path ? [path] : [];
        });
        const workspacePathsFor = (root: string) => {
          const paths = [root];
          const pathSet = new Set(paths);
          for (const path of localPaths) {
            if (pathSet.has(path)) continue;
            paths.push(path);
            pathSet.add(path);
          }
          return paths;
        };

        setPhase("starting-engine", "Starting your workspace");
        let engineStartResult = await engineStart(workspaceRoot, {
          runtime: "direct",
          workspacePaths: workspacePathsFor(workspaceRoot),
          openworkRemoteAccess: readOpenworkServerSettings().remoteAccessEnabled === true,
        }).catch((error) => {
          console.warn("[desktop-boot] engineStart failed:", error);
          return null;
        }) as EngineInfo | null;

        if (!engineStartResult) {
          const fallback = list.workspaces.find((entry) => {
            const path = entry.path?.trim() ?? "";
            return entry.workspaceType !== "remote" && path && path !== workspaceRoot;
          });
          const fallbackRoot = fallback?.path?.trim() ?? "";
          if (fallback && fallbackRoot) {
            console.warn("[desktop-boot] selected workspace failed; trying fallback workspace", {
              selectedWorkspaceId: workspace.id,
              fallbackWorkspaceId: fallback.id,
            });
            setPhase("starting-engine", "Starting another workspace");
            engineStartResult = await engineStart(fallbackRoot, {
              runtime: "direct",
              workspacePaths: workspacePathsFor(fallbackRoot).filter((path) => path !== workspaceRoot),
              openworkRemoteAccess: readOpenworkServerSettings().remoteAccessEnabled === true,
            }).catch((error) => {
              console.warn("[desktop-boot] fallback engineStart failed:", error);
              setError(error instanceof Error ? error.message : safeStringify(error));
              return null;
            }) as EngineInfo | null;
            if (engineStartResult) {
              void workspaceSetSelected(fallback.id).catch(() => undefined);
              void workspaceSetRuntimeActive(fallback.id).catch(() => undefined);
            }
          } else {
            setError("Failed to start the selected workspace.");
          }
        }

        if (engineStartResult) {
          if (engineStartResult.baseUrl) {
            setActive(engineStartResult.baseUrl);
          }
          try {
            const freshInfo = await openworkServerInfo() as OpenworkServerInfo | null;
            if (freshInfo?.baseUrl) {
              writeOpenworkServerSettings({
                urlOverride: freshInfo.baseUrl,
                token:
                  freshInfo.ownerToken?.trim() ||
                  freshInfo.clientToken?.trim() ||
                  undefined,
                hostToken: freshInfo.hostToken?.trim() || undefined,
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
