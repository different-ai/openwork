import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveGlobalOpencodeConfigPath } from "@openwork/paths";

export const CURSOR_ACP_PLUGIN_FILENAME = "cursor-acp.js";

export function resolveLocalCursorAcpPluginPath(): string | null {
  const pluginPath = join(dirname(resolveGlobalOpencodeConfigPath()), "plugin", CURSOR_ACP_PLUGIN_FILENAME);
  return existsSync(pluginPath) ? pluginPath : null;
}
