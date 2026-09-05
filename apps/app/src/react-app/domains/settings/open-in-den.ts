import type { LibraryAddKind } from "./library";

export type DenLibraryTarget = {
  id: string;
  pluginId?: string;
};

/** Same create routes the Cloud dashboard already uses. */
export const DEN_ADD_PATHS: Record<LibraryAddKind, string | null> = {
  skill: "/dashboard/plugins/new",
  command: "/dashboard/plugins/new",
  agent: "/dashboard/plugins/new",
  plugin: "/dashboard/plugins/import",
  connection: "/dashboard/mcp-connections",
  mcp: "/dashboard/library",
  "workspace-mcp": null,
};

export function denAddUrl(baseUrl: string, kind: LibraryAddKind): string | null {
  const trimmed = baseUrl.trim();
  const path = DEN_ADD_PATHS[kind];
  if (!trimmed || !path) return null;
  return new URL(path, trimmed).toString();
}

export function denLibraryFocus(target: DenLibraryTarget): string | null {
  if (target.id.startsWith("org-mcp:")) {
    const connectionId = target.id.slice("org-mcp:".length);
    return connectionId ? `connection-${connectionId}` : null;
  }
  if (target.pluginId) return `plugin-${target.pluginId}`;
  if (target.id.startsWith("openwork-connect:")) {
    const pluginId = target.id.split(":")[1];
    return pluginId ? `plugin-${pluginId}` : null;
  }
  if (target.id.startsWith("openwork-connect://")) {
    const pluginId = target.id.slice("openwork-connect://".length).split("/")[1];
    return pluginId ? `plugin-${pluginId}` : null;
  }
  if (target.id.startsWith("marketplace:")) {
    const pluginId = target.id.split(":").at(-1);
    return pluginId ? `plugin-${pluginId}` : null;
  }
  return null;
}

export function openInDenLibraryUrl(baseUrl: string, target: DenLibraryTarget): string | null {
  const focus = denLibraryFocus(target);
  if (!baseUrl.trim() || !focus) return null;
  return new URL(`/dashboard/library?focus=${encodeURIComponent(focus)}`, baseUrl).toString();
}

export function shouldShowOpenInDenAction(
  baseUrl: string,
  hasCloudSession: boolean,
  target: DenLibraryTarget,
): boolean {
  return hasCloudSession && Boolean(baseUrl.trim()) && denLibraryFocus(target) !== null;
}
