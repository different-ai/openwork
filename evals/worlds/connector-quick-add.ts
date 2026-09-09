import type { Seed } from "@openwork/env";
import { SkipError } from "@openwork/env";

/** Curated API-key presets whose hosted server also answers unauthenticated MCP requests with an OAuth challenge. */
export const API_KEY_PRESET_ID = "render";

/**
 * The hosted server behind the API-key preset is a third party: the journey
 * only proves the quick-add form when that server still answers an
 * unauthenticated initialize with a 401 OAuth challenge. Anything else skips
 * loudly instead of passing on a probe that never classified the server.
 */
async function hostedServerAdvertisesOAuth(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openwork-eval-probe", version: "0" } } }),
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    return response.status === 401 && /resource_metadata=/.test(response.headers.get("www-authenticate") ?? "");
  } catch {
    return false;
  }
}

export async function connectorQuickAddPresetAuth(seed: Seed) {
  const den = await seed.den({
    org: { name: `Quick add preset auth ${Date.now()}`, admin: { name: "Quick Add Admin" } },
    // A synthetic OAuth-only MCP server whose request log witnesses that Den
    // really probed it while the custom-server form was open.
    mocks: { connector: seed.mock() },
  });
  const presets = await seed.api(den.admin, "/v1/mcp-connections/presets");
  const body: unknown = presets.body;
  if (typeof body !== "object" || body === null || !Array.isArray(Reflect.get(body, "presets"))) throw new Error("Den did not return its connector presets.");
  const preset: unknown = Reflect.get(body, "presets").find((entry: unknown) => typeof entry === "object" && entry !== null && Reflect.get(entry, "presetId") === API_KEY_PRESET_ID);
  if (typeof preset !== "object" || preset === null) throw new Error(`Den has no ${API_KEY_PRESET_ID} preset.`);
  const presetUrl = Reflect.get(preset, "url");
  const presetName = Reflect.get(preset, "displayName");
  const presetAuthType = Reflect.get(preset, "authType");
  if (typeof presetUrl !== "string" || typeof presetName !== "string" || presetAuthType !== "apikey") throw new Error(`The ${API_KEY_PRESET_ID} preset is not an API-key preset.`);
  if (!await hostedServerAdvertisesOAuth(presetUrl)) throw new SkipError(`${presetUrl} did not answer an unauthenticated initialize with a 401 OAuth challenge`);
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/mcp-connections", headless: true, viewport: { width: 1440, height: 1400 } });
  return { den, web, presetUrl, presetName, oauthOnlyServerUrl: den.mocks.connector.mcpUrl, connector: den.mocks.connector };
}
