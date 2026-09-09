import type { Seed } from "@openwork/env";
import { SkipError } from "@openwork/env";

/** Curated API-key preset whose hosted server also answers unauthenticated MCP requests with an OAuth challenge. */
export const API_KEY_PRESET_ID = "render";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function organizationId(seed: Seed, session: Parameters<Seed["api"]>[0]): Promise<string> {
  const result = await seed.api(session, "/v1/me/orgs");
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const id = orgs[0]?.id;
  if (!result.response.ok || typeof id !== "string") throw new Error(`Resolving the active organization failed: HTTP ${result.response.status}`);
  return id;
}

export async function connectorQuickAddPresetAuth(seed: Seed) {
  const den = await seed.den({
    org: { name: `Quick add preset auth ${Date.now()}`, admin: { name: "Quick Add Admin" } },
    // A synthetic OAuth-only MCP server whose request log witnesses that Den
    // really probed it while the custom-server form was open.
    mocks: { connector: seed.mock() },
  });
  const orgId = await organizationId(seed, den.admin);
  const presets = await seed.api(den.admin, "/v1/mcp-connections/presets");
  const presetList = isRecord(presets.body) && Array.isArray(presets.body.presets) ? presets.body.presets.filter(isRecord) : null;
  if (!presetList) throw new Error("Den did not return its connector presets.");
  const preset = presetList.find((entry) => entry.presetId === API_KEY_PRESET_ID);
  if (!preset) throw new Error(`Den has no ${API_KEY_PRESET_ID} preset.`);
  const presetUrl = preset.url;
  const presetName = preset.displayName;
  if (typeof presetUrl !== "string" || typeof presetName !== "string" || preset.authType !== "apikey") throw new Error(`The ${API_KEY_PRESET_ID} preset is not an API-key preset.`);

  // The preset's hosted server is a third party. Ask the same Den discovery
  // the dialog uses how it classifies that URL right now: the journey only
  // proves anything when Den sees a conflicting OAuth requirement, so any
  // other classification skips loudly instead of passing on a probe that
  // never disagreed with the preset.
  const discover = await seed.api(den.admin, "/v1/mcp-connections/discover", {
    method: "POST",
    headers: { "x-openwork-org-id": orgId },
    body: JSON.stringify({ url: presetUrl }),
  });
  const authentication = isRecord(discover.body) && isRecord(discover.body.authentication) ? discover.body.authentication : null;
  const discoveredKind = authentication?.kind;
  const discoveredRegistration = authentication?.recommendedRegistrationMethod;
  if (!discover.response.ok || typeof discoveredKind !== "string" || typeof discoveredRegistration !== "string") {
    throw new SkipError(`Den could not discover ${presetUrl} (HTTP ${discover.response.status})`);
  }
  if (discoveredKind !== "oauth") throw new SkipError(`Den classified ${presetUrl} as ${discoveredKind}, not the conflicting oauth requirement this journey needs`);

  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/mcp-connections", headless: true, viewport: { width: 1440, height: 1400 } });
  return {
    den,
    web,
    presetUrl,
    presetName,
    /** How Den's own requirements discovery classified the preset URL just before the dialog opened. */
    discovered: { kind: discoveredKind, registration: discoveredRegistration },
    oauthOnlyServerUrl: den.mocks.connector.mcpUrl,
    connector: den.mocks.connector,
  };
}
