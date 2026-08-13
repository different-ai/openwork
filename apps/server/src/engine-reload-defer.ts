import { enginePoolForConfig } from "./engine-pool.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export interface EngineSessionsProbe {
  (config: ServerConfig, workspace: WorkspaceInfo): Promise<boolean>;
}

/**
 * OpenCode's instance cache and `/instance/dispose?directory=...` are scoped
 * to one directory. Only the target directory can be interrupted by this
 * reload; sessions in other workspaces on the same server are independent.
 * A rollover pool does not need to defer because it leaves live sessions on
 * the draining generation.
 */
export async function shouldDeferInPlaceEngineReload(
  config: ServerConfig,
  target: WorkspaceInfo,
  hasActiveSessions: EngineSessionsProbe,
): Promise<boolean> {
  if (enginePoolForConfig(config)) return false;
  return hasActiveSessions(config, target);
}
