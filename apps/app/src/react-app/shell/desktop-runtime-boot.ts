/** @jsxImportSource react */
import { useEffect } from "react";

import {
  engineInfo,
  engineStart,
  micxServerInfo,
  micxServerRestart,
  resolveWorkspaceListSelectedId,
  runtimeBootstrap,
  workspaceBootstrap,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  type EngineInfo,
  type MicxServerInfo,
  type WorkspaceInfo,
  type WorkspaceList,
} from "../../app/lib/desktop";
import { ingestMigrationSnapshotOnElectronBoot } from "../../app/lib/migration";
import {
  hydrateMicxServerSettingsFromEnv,
  readMicxServerSettings,
  writeMicxServerSettings,
} from "../../app/lib/micx-server";
import { isDesktopRuntime, isElectronRuntime, safeStringify } from "../../app/utils";
import { useServer } from "../kernel/server-provider";
import { useBootState } from "./boot-state";

// Module-scoped latch so React Strict-Mode's "mount-unmount-remount" cycle in
// dev only triggers the boot sequence once per app launch, and the async work
// keeps running across the transient unmount.
let BOOT_STARTED = false;

type BootMicxServerInfo = {
  running?: boolean | null;
  baseUrl?: string | null;
  ownerToken?: string | null;
  clientToken?: string | null;
  hostToken?: string | null;
  port?: number | null;
  remoteAccessEnabled?: boolean;
};

function isMicxServerInfoLike(info: unknown): info is BootMicxServerInfo {
  return typeof info === "object" && info !== null;
}

function isMicxServerReady(info?: BootMicxServerInfo) {
  return Boolean(
    info?.running === true &&
      info.baseUrl?.trim() &&
      (info.ownerToken?.trim() || info.clientToken?.trim()),
  );
}

/**
 * On desktop (Tauri) startup:
 *   1) bootstrap the workspace list
 *   2) if a local workspace is selected, restart the embedded Micx server
 *   3) start the OpenCode engine pointed at the workspace
 *   4) activate the workspace on the running Micx server
 *   5) notify React routes that fresh desktop runtime info is available. Electron
 *      routes read live runtime info directly instead of persisting ephemeral
 *      localhost ports/tokens into Micx settings.
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
        hydrateMicxServerSettingsFromEnv();
        const preferredRemoteAccess = readMicxServerSettings().remoteAccessEnabled === true;

        const publishMicxServerInfo = (serverInfo: BootMicxServerInfo | null | undefined) => {
          if (!serverInfo?.baseUrl) return;
          writeMicxServerSettings({
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
            window.dispatchEvent(new CustomEvent("micx-server-settings-changed"));
          } catch {
            /* ignore */
          }
        };

        const startServerWithoutDesktopWorkspace = async () => {
          setPhase("starting-engine", "Starting Micx server");
          const serverInfo = await micxServerRestart({ remoteAccessEnabled: preferredRemoteAccess }).catch((error) => {
            console.warn("[desktop-boot] micxServerRestart failed:", error);
            return null;
          });
          if (!isMicxServerInfoLike(serverInfo) || !isMicxServerReady(serverInfo)) {
            setError("Micx server did not finish starting. Please restart Micx.");
            return;
          }
          publishMicxServerInfo(serverInfo);
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
            micxServer?: BootMicxServerInfo;
          };

          if (boot.ok === false) {
            setError(boot.error || "Failed to start Micx runtime");
            return;
          }

          if (!boot.skipped && !isMicxServerReady(boot.micxServer)) {
            setError("Micx server did not finish starting. Please restart Micx.");
            return;
          }

          if (boot.engine?.baseUrl) {
            setActive(boot.engine.baseUrl);
          }
          let serverInfo = boot.micxServer;
          if (preferredRemoteAccess && serverInfo?.remoteAccessEnabled !== true) {
            const restarted = await micxServerRestart({ remoteAccessEnabled: true }).catch((error) => {
              console.warn("[desktop-boot] micxServerRestart failed:", error);
              return null;
            });
            if (isMicxServerInfoLike(restarted)) serverInfo = restarted;
          }
          publishMicxServerInfo(serverInfo);
          markReady();
          return;
        }

        // FAST PATH ─────────────────────────────────────────────────────
        // Cheap status probe: if engine is already running just publish the
        // current micx-server base URL + token and finish in <1s.
        // This mirrors Solid's bootstrap at context/workspace.ts:3883-3907
        // ("localAttachExisting"), which never restarts a running stack.
        try {
          const engine = await engineInfo() as EngineInfo | null;
          if (engine?.running && engine.baseUrl) {
            setActive(engine.baseUrl);
            const fresh = await micxServerInfo().catch(() => null) as MicxServerInfo | null;
            if (fresh?.baseUrl) {
              writeMicxServerSettings({
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
                  new CustomEvent("micx-server-settings-changed"),
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
        // micx-server and lets that server manage OpenCode.
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
          micxRemoteAccess: readMicxServerSettings().remoteAccessEnabled === true,
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
              micxRemoteAccess: readMicxServerSettings().remoteAccessEnabled === true,
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
            const freshInfo = await micxServerInfo() as MicxServerInfo | null;
            if (freshInfo?.baseUrl) {
              writeMicxServerSettings({
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
                window.dispatchEvent(new CustomEvent("micx-server-settings-changed"));
              } catch {
                /* ignore */
              }
            }
          } catch (error) {
            console.warn("[desktop-boot] post-engineStart micxServerInfo failed:", error);
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
