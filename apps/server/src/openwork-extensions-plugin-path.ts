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

export function openworkPluginPath(name: string, here = dirname(fileURLToPath(import.meta.url))): string {
  const resourcesPath = resourcesPathFromAppAsarPath(here);
  if (resourcesPath) {
    const electronResourcesPath = process.resourcesPath?.includes("app.asar") ? resourcesPath : process.resourcesPath?.trim();
    return join(electronResourcesPath || resourcesPath, "opencode-plugins", `${name}.js`);
  }

  const extension = basename(here) === "dist" ? "js" : "ts";
  return join(here, "opencode-plugins", `${name}.${extension}`);
}

export const openworkExtensionsPreviewPluginPath = () => openworkPluginPath("openwork-extensions-preview");
export const openworkCapabilitiesKnowledgePluginPath = () => openworkPluginPath("openwork-capabilities-knowledge");
export const openworkAnthropicAdaptiveThinkingPluginPath = () => openworkPluginPath("openwork-anthropic-adaptive-thinking");
export const openworkAnthropicToolSchemaPluginPath = () => openworkPluginPath("openwork-anthropic-tool-schema");
