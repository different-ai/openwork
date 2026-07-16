/**
 * Pure projection logic for the smart add-connection flow: classify what the
 * admin typed, surface instant preset suggestions, and turn a server-side
 * resolution into either a one-click add or a guided handoff to the full
 * form. Everything here is deterministic so it stays unit-testable without
 * rendering the dialog.
 */
import type {
  CreateMcpConnectionInput,
  ExternalMcpPreset,
  McpRequirementsDiscovery,
} from "./mcp-connections-data";

export type SmartAddInputKind = "empty" | "url" | "domain" | "name" | "invalid";

const NAME_QUERY_PATTERN = /^[a-z0-9][a-z0-9 &_'-]{0,63}$/i;

export function classifySmartAddInput(rawQuery: string): SmartAddInputKind {
  const query = rawQuery.trim();
  if (!query) return "empty";
  if (query.length > 200) return "invalid";

  if (/^https?:\/\//i.test(query)) {
    try {
      const parsed = new URL(query);
      return parsed.username || parsed.password || parsed.hash ? "invalid" : "url";
    } catch {
      return "invalid";
    }
  }

  if (query.includes(".") && !/\s/.test(query)) {
    try {
      const parsed = new URL(`https://${query}`);
      return parsed.username || parsed.password || parsed.hash ? "invalid" : "domain";
    } catch {
      return "invalid";
    }
  }

  return NAME_QUERY_PATTERN.test(query) ? "name" : "invalid";
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Instant, local suggestions while the admin types — prefix matches on the
 * display name rank first, then substring and host matches. The server-side
 * resolve stays the authority for anything beyond the curated presets.
 */
export function filterPresetSuggestions(
  presets: readonly ExternalMcpPreset[],
  rawQuery: string,
  limit = 3,
): ExternalMcpPreset[] {
  const query = rawQuery.trim();
  const normalized = normalizeText(query);
  if (normalized.length < 2) return [];
  const queryHost = hostnameOf(query) ?? hostnameOf(`https://${query}`);

  const prefix: ExternalMcpPreset[] = [];
  const partial: ExternalMcpPreset[] = [];
  for (const preset of presets) {
    const name = normalizeText(preset.displayName);
    const id = normalizeText(preset.presetId);
    if (name.startsWith(normalized) || id.startsWith(normalized)) {
      prefix.push(preset);
    } else if (
      name.includes(normalized)
      || id.includes(normalized)
      || (queryHost !== null && hostnameOf(preset.url) === queryHost)
    ) {
      partial.push(preset);
    }
  }
  return [...prefix, ...partial].slice(0, limit);
}

export type SmartAddPlan =
  | { readiness: "one_click"; input: CreateMcpConnectionInput }
  | { readiness: "needs_details"; reasons: string[] }
  | { readiness: "unsupported"; reasons: string[] };

const EVERYONE_ACCESS = { orgWide: true, memberIds: [], teamIds: [] } as const;

/**
 * Decide whether a resolved server can be added in one click with safe
 * defaults (everyone in the org; each member signs in with their own account
 * for OAuth), or whether the admin has to finish setup in the full form.
 */
export function planSmartAdd(
  discovery: McpRequirementsDiscovery,
  target: { name: string; url: string },
): SmartAddPlan {
  if (discovery.status === "unreachable") {
    return { readiness: "unsupported", reasons: ["We couldn't reach an MCP server at this address."] };
  }

  if (discovery.status === "ready") {
    if (discovery.authentication.kind === "none") {
      return {
        readiness: "one_click",
        input: {
          name: target.name,
          url: target.url,
          authType: "none",
          credentialMode: "shared",
          access: { ...EVERYONE_ACCESS, memberIds: [], teamIds: [] },
        },
      };
    }
    if (discovery.authentication.kind === "oauth") {
      const servers = discovery.authentication.authorizationServers;
      return {
        readiness: "one_click",
        input: {
          name: target.name,
          url: target.url,
          authType: "oauth",
          credentialMode: "per_member",
          ...(servers.length === 1 ? { authorizationServerIssuer: servers[0].issuer } : {}),
          requestedScopes: [...new Set([
            ...discovery.authentication.requiredScopes,
            ...discovery.authentication.recommendedScopes,
          ])],
          access: { ...EVERYONE_ACCESS, memberIds: [], teamIds: [] },
        },
      };
    }
  }

  const reasons = discovery.manualRequirements
    .filter((requirement) => requirement.required)
    .map((requirement) => requirement.label);
  if (discovery.authentication.kind === "manual_bearer" && !reasons.includes("API key")) {
    reasons.push("This server expects an API key or bearer token.");
  }
  if (reasons.length === 0) {
    reasons.push("This server needs a closer look before it can be added.");
  }
  return { readiness: "needs_details", reasons };
}

/** Human labels for the detected sign-in requirement, shown on the result card. */
export function smartAddAuthLabel(discovery: McpRequirementsDiscovery): string {
  switch (discovery.authentication.kind) {
    case "none":
      return "No sign-in needed";
    case "oauth":
      return "OAuth sign-in";
    case "manual_bearer":
      return "API key";
    default:
      return "Sign-in unclear";
  }
}
