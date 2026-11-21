import { enginePoolForConfig } from "./engine-pool.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export interface EngineSessionsProbe {
  (config: ServerConfig, workspace: WorkspaceInfo): Promise<boolean>;
}

export async function shouldDeferInPlaceEngineReload(
  config: ServerConfig,
  target: WorkspaceInfo,
  hasActiveSessions: EngineSessionsProbe,
): Promise<boolean> {
  if (enginePoolForConfig(config)) return false;
  return hasActiveSessions(config, target);
}
