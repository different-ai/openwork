import { enginePoolForConfig } from "./engine-pool.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export interface EngineSessionsProbe {
  (config: ServerConfig, workspace: WorkspaceInfo): Promise<boolean>;
}

/**
 * A reload that lands while sessions are running has only had bad options:
 * dispose and abort the runs, or defer and leave config stale until idle.
 * A rollover-capable pool picks the third option (standby, flip, drain), so
 * deferral applies only to in-place reloads — the default.
 *
 * `unknown` must never park reloads forever: probes that cannot tell resolve
 * false, and a reload against a dead engine fails loudly on its own.
 */
export async function shouldDeferInPlaceEngineReload(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  hasActiveSessions: EngineSessionsProbe,
): Promise<boolean> {
  return !enginePoolForConfig(config) && (await hasActiveSessions(config, workspace));
}