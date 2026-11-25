/** @jsxImportSource react */
import { createElement, useEffect } from "react";

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
  writeOpenworkServerSettings,
} from "../../app/lib/openwork-server";
import { isDesktopRuntime, isElectronRuntime, safeStringify } from "../../app/utils";
import { useEnterpriseActivationRequired } from "../domains/cloud/enterprise-activation-gate";
import { useServer } from "../kernel/server-provider";
import { useBootState } from "./boot-state";

let BOOT_STARTED = false;

type BootOpenworkServerInfo = {
  running?: boolean | null;
  baseUrl?: string | null;
  ownerToken?: string | null;
  clientToken?: string | null;
  hostToken?: string | null;
  port?: number | null;
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

export function useDesktopRuntimeBoot() {
  const { setPhase, setError, markReady } = useBootState();
  const { setActive } = useServer();

  useEffect(() => {
    if (!isDesktopRuntime()) {
      markReady();
      return;
    }
    if (BOOT_STARTED) return;
    BOOT_STARTED = true;

    void (async () => {
      try {
        const evalFatalFailure = window.__OPENWORK_ELECTRON__?.meta?.evalFatalBootstrapFailure;
        if (evalFatalFailure) throw new Error(evalFatalFailure);
        if (isElectronRuntime()) {
          const hydrated = await ingestMigrationSnapshotOnElectronBoot();
          if (hydrated > 0) {
            // eslint-disable-next-line no-console -- valuable one-time signal
            console.info(`[migration] hydrated ${hydrated} localStorage keys from Tauri snapshot`);
          }
        }
        hydrateOpenworkServerSettingsFromEnv();

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
          });
          try {
            window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
          } catch {
          }
        };

        const startServerWithoutDesktopWorkspace = async () => {
          const running = await openworkServerInfo().catch(() => null);
          if (isOpenworkServerInfoLike(running) && isOpenworkServerReady(running)) {
            publishOpenworkServerInfo(running);
            await window.__OPENWORK_ELECTRON__?.recovery?.recordHealthy?.().catch(() => undefined);
            markReady();
            return;
          }
          setPhase("starting-engine", "Starting OpenWork server");
          const serverInfo = await openworkServerRestart({ diagnosticsCause: "startup-recovery" }).catch((error) => {
            console.warn("[desktop-boot] openworkServerRestart failed:", error);
            return null;
          });
          if (!isOpenworkServerInfoLike(serverInfo) || !isOpenworkServerReady(serverInfo)) {
            setError("OpenWork server did not finish starting. Please restart OpenWork.");
            return;
          }
          publishOpenworkServerInfo(serverInfo);
          await window.__OPENWORK_ELECTRON__?.recovery?.recordHealthy?.().catch(() => undefined);
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
        if (!workspace) {
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
          publishOpenworkServerInfo(boot.openworkServer);
          await window.__OPENWORK_ELECTRON__?.recovery?.recordHealthy?.().catch(() => undefined);
          markReady();
          return;
        }

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
              });
              try {
                window.dispatchEvent(
                  new CustomEvent("openwork-server-settings-changed"),
                );
              } catch {
              }
            }
            markReady();
            return;
          }
        } catch {
        }

        const localPaths = list.workspaces.flatMap((entry: WorkspaceInfo) => {
          const path = entry.path?.trim() ?? "";
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
        }).catch((error) => {
          console.warn("[desktop-boot] engineStart failed:", error);
          return null;
        }) as EngineInfo | null;

        if (!engineStartResult) {
          const fallback = list.workspaces.find((entry) => {
            const path = entry.path?.trim() ?? "";
            return path && path !== workspaceRoot;
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
              });
              try {
                window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
              } catch {
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

function ActivatedDesktopRuntimeBoot(): null {
  useDesktopRuntimeBoot();
  return null;
}

export function DesktopRuntimeBoot() {
  if (useEnterpriseActivationRequired()) return null;
  return createElement(ActivatedDesktopRuntimeBoot);
}
