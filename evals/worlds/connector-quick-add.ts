import type { Seed } from "@openwork/env";
import { SkipError } from "@openwork/env";

/** Render uses OpenWork's public pre-registered OAuth app. */
export const OAUTH_PRESET_ID = "render";

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
  const preset = presetList.find((entry) => entry.presetId === OAUTH_PRESET_ID);
  if (!preset) throw new Error(`Den has no ${OAUTH_PRESET_ID} preset.`);
  const presetUrl = preset.url;
  const presetName = preset.displayName;
  if (typeof presetUrl !== "string" || typeof presetName !== "string" || preset.authType !== "oauth" || preset.defaultOAuthClientId !== "openwork") throw new Error(`The ${OAUTH_PRESET_ID} preset does not supply OpenWork's OAuth app.`);

  // Read the real hosted server metadata without signing in to a Render account.
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
  if (discoveredKind !== "oauth") throw new SkipError(`Den classified ${presetUrl} as ${discoveredKind}, not the OAuth requirement this journey needs`);

  const created = await seed.orgConnection(den.admin, {
    name: "Render preset verification", url: presetUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true },
  });
  const started = await seed.api(den.admin, `/v1/mcp-connections/${created.id}/connect/start`);
  if (!started.response.ok || !isRecord(started.body) || typeof started.body.authorizeUrl !== "string") {
    throw new Error(`Render did not produce an authorization URL: HTTP ${started.response.status}`);
  }
  const authorizeUrl = started.body.authorizeUrl;
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/mcp-connections/new", headless: true, viewport: { width: 1440, height: 1400 } });
  return {
    den,
    web,
    authorizeUrl,
    presetConnectionId: created.id,
    presetUrl,
    presetName,
    /** How Den's own requirements discovery classified the preset URL just before the dialog opened. */
    discovered: { kind: discoveredKind, registration: discoveredRegistration },
    oauthOnlyServerUrl: den.mocks.connector.mcpUrl,
    connector: den.mocks.connector,
  };
}
