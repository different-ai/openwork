import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Keeps the engine OpenWork bundles away from a separate OpenCode install.
 *
 * OpenCode reads its global config from `$XDG_CONFIG_HOME/opencode` (default
 * `~/.config/opencode`): `config.json`, `opencode.json(c)`, and the plugins,
 * commands, agents and skills folders next to them. It also installs plugin
 * dependencies there. A user who runs their own OpenCode keeps that folder for
 * it, and one malformed file there used to stop OpenWork's engine from
 * starting. The managed engine gets an XDG config home inside OpenWork's own
 * storage instead. HOME stays unchanged so shells, git and ssh still work.
 *
 * Data, state and cache folders are not moved: OpenWork's v1 chat history,
 * provider credentials and MCP sign-ins live in OpenCode's data folder today
 * and cannot be told apart from a separate install's entries there.
 */
export function managedEngineConfigHome(storageDir: string): string {
  return join(storageDir, "engine-config");
}

/** Environment for a managed v1 engine; creates the private config home. */
export async function managedEngineIsolationEnv(storageDir: string): Promise<{ XDG_CONFIG_HOME: string }> {
  const configHome = managedEngineConfigHome(storageDir);
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  return { XDG_CONFIG_HOME: configHome };
}
