import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare global {
  namespace NodeJS {
    interface Process {
      resourcesPath?: string;
    }
  }
}

function resourcesPathFromAppAsarPath(path: string): string | null {
  const match = /[\\/]app\.asar(?:[\\/]|$)/.exec(path);
  return match ? path.slice(0, match.index) : null;
}

export function openworkPluginPath(name: string, here?: string): string {
  const pluginDir = process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR;
  if (pluginDir) {
    return join(pluginDir, `${name}.js`);
  }

  here = here ?? dirname(fileURLToPath(import.meta.url));
  const resourcesPath = resourcesPathFromAppAsarPath(here);
  if (resourcesPath) {
    const electronResourcesPath = process.resourcesPath?.includes("app.asar") ? resourcesPath : process.resourcesPath?.trim();
    return join(electronResourcesPath || resourcesPath, "opencode-plugins", `${name}.js`);
  }

  const extension = basename(here) === "dist" ? "js" : "ts";
  return join(here, "opencode-plugins", `${name}.${extension}`);
}

export const openworkGatewayQuotaV2PluginPath = () => openworkPluginPath("openwork-gateway-quota-v2");
export const openworkContextV2PluginPath = () => openworkPluginPath("openwork-context-v2");
export const openworkProviderFiltersV2PluginPath = () => openworkPluginPath("openwork-provider-filters-v2");
export const openworkMcpResultsV2PluginPath = () => openworkPluginPath("openwork-mcp-results-v2");
export const openworkMcpReadinessV2PluginPath = () => openworkPluginPath("openwork-mcp-readiness-v2");
export const openworkAgentPermissionsV2PluginPath = () => openworkPluginPath("openwork-agent-permissions-v2");
