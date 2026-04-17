/** @jsxImportSource react */
import { useEffect, useRef } from "react";

import {
  engineStart,
  openworkServerRestart,
  orchestratorWorkspaceActivate,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
} from "../../app/lib/tauri";
import { hydrateOpenworkServerSettingsFromEnv, writeOpenworkServerSettings } from "../../app/lib/openwork-server";
import { isTauriRuntime } from "../../app/utils";

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
  const didBoot = useRef(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    if (didBoot.current) return;
    didBoot.current = true;

    let cancelled = false;

    void (async () => {
      try {
        hydrateOpenworkServerSettingsFromEnv();

        const list = await workspaceBootstrap().catch(() => null);
        if (!list || cancelled) return;

        const selectedId = resolveWorkspaceListSelectedId(list);
        if (!selectedId) return;

        const workspace = list.workspaces.find((w) => w.id === selectedId);
        if (!workspace) return;

        // Remote workspaces already point at an OpenWork server; nothing to spawn locally.
        if (workspace.workspaceType === "remote") return;

        const workspaceRoot = workspace.path?.trim();
        if (!workspaceRoot) return;

        const info = await openworkServerRestart({ remoteAccessEnabled: false }).catch(
          (error) => {
            console.warn("[desktop-boot] openworkServerRestart failed:", error);
            return null;
          },
        );

        if (info?.baseUrl && (info.ownerToken || info.clientToken)) {
          writeOpenworkServerSettings({
            urlOverride: info.baseUrl,
            token: info.ownerToken ?? info.clientToken ?? "",
          });
          try {
            window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
          } catch {
            /* ignore */
          }
        }

        await engineStart(workspaceRoot, {
          runtime: "openwork-orchestrator",
          workspacePaths: [workspaceRoot],
        }).catch((error) => {
          console.warn("[desktop-boot] engineStart failed:", error);
        });

        await orchestratorWorkspaceActivate({
          workspacePath: workspaceRoot,
          name: workspace.name ?? workspace.displayName ?? null,
        }).catch((error) => {
          console.warn("[desktop-boot] orchestratorWorkspaceActivate failed:", error);
        });
      } catch (error) {
        console.warn("[desktop-boot] fatal:", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
