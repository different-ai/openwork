import type { Seed } from "@openwork/env";
import { SkipError } from "@openwork/env";

/**
 * Curated preset whose hosted authorization server accepts neither client
 * metadata documents nor dynamic registration, so OpenWork can only sign in
 * with a client the provider registered by hand. The eval Den is booted with
 * that client supplied deployment-wide, the way hosted OpenWork Cloud is.
 */
export const PRE_REGISTERED_PRESET_ID = "render";
/** The preset's server URL, fixed here because Den's environment is set before Den can be asked for it. */
export const PRE_REGISTERED_PRESET_URL = "https://mcp.render.com/mcp";
/** Synthetic client id the deployment supplies for that server; OAuth is never started against the real provider. */
export const DEPLOYMENT_CLIENT_ID = "openwork-eval-client";
/** Curated preset that also needs a pre-registered client but for which the deployment holds none. */
export const OAUTH_APP_PRESET_ID = "slack";

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
    env: {
      DEN_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS: JSON.stringify({
        [PRE_REGISTERED_PRESET_URL]: { clientId: DEPLOYMENT_CLIENT_ID },
      }),
    },
    // A synthetic OAuth-only MCP server with no preset and no deployment
    // client, so only Den's live probe can classify it.
    mocks: { connector: seed.mock() },
  });
  const orgId = await organizationId(seed, den.admin);
  const presets = await seed.api(den.admin, "/v1/mcp-connections/presets");
  const presetList = isRecord(presets.body) && Array.isArray(presets.body.presets) ? presets.body.presets.filter(isRecord) : null;
  if (!presetList) throw new Error("Den did not return its connector presets.");
  const preset = presetList.find((entry) => entry.presetId === PRE_REGISTERED_PRESET_ID);
  if (!preset) throw new Error(`Den has no ${PRE_REGISTERED_PRESET_ID} preset.`);
  const presetName = preset.displayName;
  if (preset.url !== PRE_REGISTERED_PRESET_URL) throw new Error(`The ${PRE_REGISTERED_PRESET_ID} preset moved to ${String(preset.url)}; update PRE_REGISTERED_PRESET_URL.`);
  if (typeof presetName !== "string" || preset.authType !== "oauth" || !Array.isArray(preset.supportedAuthTypes) || !preset.supportedAuthTypes.includes("apikey")) {
    throw new Error(`The ${PRE_REGISTERED_PRESET_ID} preset is not an OAuth preset with an API-key alternative.`);
  }
  const oauthAppPreset = presetList.find((entry) => entry.presetId === OAUTH_APP_PRESET_ID);
  if (!oauthAppPreset || typeof oauthAppPreset.displayName !== "string") throw new Error(`Den has no ${OAUTH_APP_PRESET_ID} preset.`);
  if (oauthAppPreset.requiresOAuthClient !== true) throw new Error(`The ${OAUTH_APP_PRESET_ID} preset no longer needs an admin OAuth app; pick another negative preset.`);

  // The preset's hosted server is a third party. Ask the same Den discovery
  // the dialog uses how it classifies that URL right now: the journey only
  // proves anything when the provider still refuses automatic registration,
  // so any other classification skips loudly instead of passing on a probe
  // that never needed the deployment client.
  const discover = await seed.api(den.admin, "/v1/mcp-connections/discover", {
    method: "POST",
    headers: { "x-openwork-org-id": orgId },
    body: JSON.stringify({ url: PRE_REGISTERED_PRESET_URL }),
  });
  const authentication = isRecord(discover.body) && isRecord(discover.body.authentication) ? discover.body.authentication : null;
  const discoveredKind = authentication?.kind;
  const discoveredRegistration = authentication?.recommendedRegistrationMethod;
  if (!discover.response.ok || typeof discoveredKind !== "string" || typeof discoveredRegistration !== "string") {
    throw new SkipError(`Den could not discover ${PRE_REGISTERED_PRESET_URL} (HTTP ${discover.response.status})`);
  }
  if (discoveredKind !== "oauth") throw new SkipError(`Den classified ${PRE_REGISTERED_PRESET_URL} as ${discoveredKind}, not the OAuth requirement this journey needs`);
  if (discoveredRegistration !== "pre_registered") {
    throw new SkipError(`${PRE_REGISTERED_PRESET_URL} now offers ${discoveredRegistration} registration, so a deployment client is no longer what unblocks it`);
  }

  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/mcp-connections/new", headless: true, viewport: { width: 1440, height: 1400 } });
  return {
    den,
    web,
    presetUrl: PRE_REGISTERED_PRESET_URL,
    presetName,
    oauthAppPresetName: oauthAppPreset.displayName,
    /** How Den's own requirements discovery classified the preset URL just before the dialog opened. */
    discovered: { kind: discoveredKind, registration: discoveredRegistration },
    oauthOnlyServerUrl: den.mocks.connector.mcpUrl,
    connector: den.mocks.connector,
  };
}
