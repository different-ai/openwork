import type { CreateMcpConnectionInput, ExternalMcpPreset } from "./mcp-connections-data";

/**
 * The tools a new workspace's owner can add during setup in one click: no sign-in, or a sign-in that needs no
 * OAuth client of their own. One per URL.
 */
export function starterTeamTools(presets: readonly ExternalMcpPreset[]): ExternalMcpPreset[] {
  return presets.filter((preset, index, all) =>
    (preset.authType === "none" || (preset.authType === "oauth" && !preset.requiresOAuthClient))
    && all.findIndex((entry) => entry.url === preset.url) === index);
}

/** A starter tool as a connection: the whole team can use it, and each person signs in with their own account. */
export function starterTeamToolConnection(preset: ExternalMcpPreset): CreateMcpConnectionInput {
  return {
    name: preset.displayName,
    url: preset.url,
    authType: preset.authType,
    credentialMode: preset.authType === "oauth" ? "per_member" : "shared",
    access: { orgWide: true, memberIds: [], teamIds: [] },
  };
}
