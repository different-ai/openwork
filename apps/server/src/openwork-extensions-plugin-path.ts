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

export function micxPluginPath(name: string, here?: string): string {
  const pluginDir = process.env.MICX_EXTENSIONS_PLUGIN_DIR;
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

export const micxExtensionsPreviewPluginPath = () => micxPluginPath("micx-extensions-preview");
export const micxCapabilitiesKnowledgePluginPath = () => micxPluginPath("micx-capabilities-knowledge");
export const micxAnthropicAdaptiveThinkingPluginPath = () => micxPluginPath("micx-anthropic-adaptive-thinking");
export const micxAnthropicToolSchemaPluginPath = () => micxPluginPath("micx-anthropic-tool-schema");
export const micxOfficeAttachmentsPluginPath = () => micxPluginPath("micx-office-attachments");
