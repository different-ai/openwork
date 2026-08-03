export type DenLibraryTarget = {
  id: string;
  pluginId?: string;
};

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
