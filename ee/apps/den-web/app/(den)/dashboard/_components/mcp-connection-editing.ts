import type {
  ExternalMcpAccessSummary,
  ExternalMcpAuthType,
  ExternalMcpCredentialMode,
  ExternalMcpRequiredBy,
} from "./mcp-connections-data";

export type McpConnectionAccessMode = "everyone" | "teams" | "people" | "none";

export function normalizeEditableMcpIdentityUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    return `${url.protocol}//${url.host}${pathname}${url.search}`;
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

export function editableMcpIdentityChanged(
  current: { url: string; authType: ExternalMcpAuthType; credentialMode: ExternalMcpCredentialMode },
  proposed: { url: string; authType: ExternalMcpAuthType; credentialMode: ExternalMcpCredentialMode },
): boolean {
  return normalizeEditableMcpIdentityUrl(current.url) !== normalizeEditableMcpIdentityUrl(proposed.url)
    || current.authType !== proposed.authType
    || current.credentialMode !== proposed.credentialMode;
}

export function mcpAccessMode(access: ExternalMcpAccessSummary | null): McpConnectionAccessMode {
  if (!access) return "none";
  if (access.orgWide) return "everyone";
  if (access.teamIds.length > 0) return "teams";
  if (access.memberIds.length > 0) return "people";
  return "none";
}

export function marketplaceIdentityOwnerNames(owners: ExternalMcpRequiredBy[]): string {
  return [...new Set(owners.map((owner) => owner.name))].join(", ");
}
