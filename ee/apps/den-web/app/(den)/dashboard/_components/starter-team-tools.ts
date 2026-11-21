import type { CreateMcpConnectionInput, ExternalMcpPreset } from "./mcp-connections-data";

export function starterTeamTools(presets: readonly ExternalMcpPreset[]): ExternalMcpPreset[] {
  return presets.filter((preset, index, all) =>
    (preset.authType === "none" || (preset.authType === "oauth" && !preset.requiresOAuthClient))
    && all.findIndex((entry) => entry.url === preset.url) === index);
}

export function starterTeamToolConnection(preset: ExternalMcpPreset): CreateMcpConnectionInput {
  return {
    name: preset.displayName,
    url: preset.url,
    authType: preset.authType,
    credentialMode: preset.authType === "oauth" ? "per_member" : "shared",
    access: { orgWide: true, memberIds: [], teamIds: [] },
  };
}
