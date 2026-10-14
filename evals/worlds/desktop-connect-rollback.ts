import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { queryDenDatabase, type Seed } from "@openwork/env";
import { buildConnectExchangeDeepLink, connectLinkClaimsSchema } from "../../packages/connect-link/src/index.ts";
import { generateConnectLinkKeyPair, signConnectLinkToken } from "../../packages/connect-link/src/node.ts";
import * as current from "../../apps/desktop/electron/connect-link.mjs";
import * as legacy from "../fixtures/legacy-desktop-connect-link/connect-link.mjs";

export const STOCK_BRAND = { appName: "OpenWork", logoUrl: null, iconUrl: null };
const FIXTURE_SHA256 = "da7091a1ccafaf4c433d674044779c711710c308764ff42ae6d31c93575d4b98";
const SYNTHETIC_PNG_HEX = "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a synthetic fixture object");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a synthetic fixture string");
  return value;
}
function metadata(value: unknown): Record<string, unknown> {
  return record(typeof value === "string" ? JSON.parse(value) : value);
}

/** Browser-less real Den producer/storage world. No app or native OS is booted. */
export async function selfHostedBranding(seed: Seed) {
  return brandingWorld(seed, "self_hosted");
}

export async function desktopConnectRollback(seed: Seed) {
  return brandingWorld(seed, "cloud");
}

async function brandingWorld(seed: Seed, deployment: "cloud" | "self_hosted") {
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim() || process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim()) {
    throw new Error("Rollback writes require a fresh testkit-owned Den, never an attached service");
  }
  const fixture = await readFile(new URL("../fixtures/legacy-desktop-connect-link/connect-link.mjs", import.meta.url));
  if (createHash("sha256").update(fixture).digest("hex") !== FIXTURE_SHA256) throw new Error("The legacy Electron verifier must stay frozen");
  const keys = generateConnectLinkKeyPair();
  const kid = "rollback-eval-ed25519";
  const publicKeys = { [kid]: keys.publicKeyPem };
  const den = await seed.den({
    web: false,
    org: { name: "Rollback compatibility workspace" },
    env: {
      DEN_DEPLOYMENT: deployment,
      DEN_CONNECT_LINK_MODE: "signed",
      DEN_CONNECT_LINK_PRIVATE_KEY: keys.privateKeyPem,
      DEN_CONNECT_LINK_KEY_ID: kid,
      // All positive localhost URLs are subject to the real loopback-only dev policy.
      OPENWORK_DEV_MODE: "1",
      DEN_DESKTOP_RELEASES_MODE: "static",
    },
  });
  if (den.placement?.kind !== "local" || !den.database) throw new Error("Rollback fixture requires the run's isolated local database");
  const databaseUrl = den.database.url;
  const database = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) || !database.pathname.startsWith("/openwork_eval_")) {
    throw new Error("Refusing rollback writes outside a disposable testkit database");
  }
  const api = (path: string, init: RequestInit = {}) => seed.api(den.admin, path, init);
  const org = await api("/v1/org");
  if (org.response.status !== 200) throw new Error(`Organization lookup: HTTP ${org.response.status} ${org.text}`);
  const organizationId = text(record(record(org.body).organization).id);
  const assetId = "rollback-fixture-logo";
  const assetVersion = "rollback-v1";
  const assetUrl = `https://assets.example.test/v1/brand-assets/${organizationId}/logo/${assetVersion}.png`;
  const logoAsset = {
    kind: "logo", version: assetVersion, extension: "png", contentType: "image/png", url: assetUrl,
    width: 1, height: 1, byteLength: SYNTHETIC_PNG_HEX.length / 2,
    originalName: "rollback-logo.png", uploadedAt: "2026-01-01T00:00:00.000Z",
  };
  const dormant = {
    brandAppName: "Dormant Workspace", brandLogoUrl: assetUrl,
    brandIconUrl: "https://assets.example.test/dormant-icon.png", brandAccentColor: "#135790",
    brandLogoAsset: logoAsset,
    brandIconAsset: { ...logoAsset, kind: "icon", version: "rollback-icon-v1", url: "https://assets.example.test/dormant-icon.png", originalName: "rollback-icon.png" },
    rollbackSentinel: { retained: true, nested: ["untouched", 17] },
  };
  const [before] = await queryDenDatabase(databaseUrl, "SELECT metadata FROM organization WHERE id = ?", [organizationId]);
  // Legacy numeric strings force a real metadata-normalization write through
  // ordinary settings edits, not just a serializer read of an already-normal row.
  const originalMetadata = { ...metadata(record(before).metadata), ...dormant, limits: { members: "5", workers: "1" } };
  await queryDenDatabase(databaseUrl, "UPDATE organization SET metadata = ? WHERE id = ?", [JSON.stringify(originalMetadata), organizationId]);
  await queryDenDatabase(databaseUrl,
    "INSERT INTO organization_brand_asset (id, organization_id, kind, version, extension, bytes) VALUES (?, ?, 'logo', ?, 'png', UNHEX(?))",
    [assetId, organizationId, assetVersion, SYNTHETIC_PNG_HEX]);

  async function stored() {
    const [row] = await queryDenDatabase(databaseUrl, "SELECT metadata FROM organization WHERE id = ?", [organizationId]);
    const assets = await queryDenDatabase(databaseUrl,
      "SELECT id, organization_id, kind, version, extension, created_at, HEX(bytes) AS bytesHex FROM organization_brand_asset WHERE organization_id = ? ORDER BY id", [organizationId]);
    return { metadata: metadata(record(row).metadata), assets: assets.map(record) };
  }
  const initial = await stored();

  return {
    den, dormant, initial, stored,
    async state() {
      const result = await api("/v1/org");
      if (result.response.status !== 200) throw new Error(`Read organization: ${result.text}`);
      const [override] = await queryDenDatabase(databaseUrl, "SELECT enabled, source FROM organization_feature WHERE organization_id = ? AND feature_key = 'whiteLabel'", [organizationId]);
      const [rollout] = await queryDenDatabase(databaseUrl, "SELECT created_at FROM feature_rollout WHERE feature_key = 'whiteLabel'");
      return { body: result.body, override: override ? record(override) : null, cutoff: rollout ? record(rollout).created_at : null };
    },
    async setEnabled(enabled: boolean | null) {
      const result = await api(`/v1/admin/organizations/${organizationId}/capabilities`, {
        method: "PUT", body: JSON.stringify({ capabilities: { whiteLabel: enabled } }),
      });
      if (result.response.status !== 200) throw new Error(`Feature override: ${result.text}`);
    },
    async setKilled(killed: boolean) {
      const result = await api("/v1/admin/features/whiteLabel", {
        method: "PUT", body: JSON.stringify({ enabled: false, killed }),
      });
      if (result.response.status !== 200) throw new Error(`Feature kill: ${result.text}`);
    },
    // Reconstruct a pre-feature deployment solely in this disposable database.
    // Startup must atomically create the rollout marker and eligible overrides;
    // later startups must not repeat migration after an admin clears an override.
    async restartWithHistoricalOrganization(configured = true) {
      await queryDenDatabase(databaseUrl, "UPDATE organization SET created_at = '2020-01-01 00:00:00.000', metadata = ? WHERE id = ?", [JSON.stringify(configured ? originalMetadata : { rollbackSentinel: dormant.rollbackSentinel }), organizationId]);
      await queryDenDatabase(databaseUrl, "DELETE FROM feature_rollout WHERE feature_key = 'whiteLabel'");
      if (!den.restartApi) throw new Error("Automatic initializer proof requires restartApi");
      await den.restartApi();
    },
    async injectBrandMetadata() {
      await queryDenDatabase(databaseUrl, "UPDATE organization SET metadata = ? WHERE id = ?", [JSON.stringify(originalMetadata), organizationId]);
    },
    async restart() {
      if (!den.restartApi) throw new Error("Automatic initializer proof requires restartApi");
      await den.restartApi();
    },
    async ordinaryEditAndRead() {
      const edited = await api("/v1/org", { method: "PATCH", body: JSON.stringify({ name: "Renamed rollback workspace", requireSso: false }) });
      const read = await api("/v1/org");
      return { editStatus: edited.response.status, editBody: edited.body, readStatus: read.response.status, readBody: read.body };
    },
    async disabledWrites() {
      const fields = await api("/v1/org", { method: "PATCH", body: JSON.stringify({ brandAppName: "Must not apply" }) });
      const upload = await api("/v1/org/brand-assets", { method: "POST", body: JSON.stringify({ kind: "logo" }) });
      return { fieldsStatus: fields.response.status, fieldsBody: fields.body, uploadStatus: upload.response.status, uploadBody: upload.body };
    },
    async mint() {
      const created = await api(`/v1/orgs/${organizationId}/install-links`, { method: "POST", body: "{}" });
      if (created.response.status !== 200) throw new Error(`Mint install link: HTTP ${created.response.status} ${created.text}`);
      const createdBody = record(created.body);
      const resolved = await fetch(`${den.ref.apiUrl}/v1/install-config?token=${encodeURIComponent(text(createdBody.token))}`);
      if (resolved.status !== 200) throw new Error(`Resolve install link: HTTP ${resolved.status} ${await resolved.text()}`);
      const config = record(await resolved.json());
      const code = new URL(text(config.activationUrl)).searchParams.get("code");
      if (!code) throw new Error("Install config omitted its exchange code");
      const exchangeUrl = buildConnectExchangeDeepLink(code, text(config.apiUrl));
      const token = legacy.extractConnectLinkToken(text(createdBody.connectUrl));
      if (!token) throw new Error("Signed mode did not mint a token through the real Den route");
      return {
        config, token, exchangeUrl,
        signed: legacy.verifyConnectLinkUrl(text(createdBody.connectUrl), { publicKeys, allowInsecureLoopback: true }),
        currentSigned: current.verifyConnectLinkUrl(text(createdBody.connectUrl), { publicKeys, allowInsecureLoopback: true }),
      };
    },
    async exchange(exchangeUrl: string, mode: "preview" | "exchange") {
      return legacy.resolveConnectExchangeUrl(exchangeUrl, { mode, fetcher: fetch, allowInsecureLoopback: true });
    },
    /** Synthetic negative vectors bypass normalization intentionally; the real signer is tested separately below. */
    async wireBoundaries() {
      const now = Math.floor(Date.now() / 1000);
      const apiBaseUrl = "https://api.example.test";
      const base = {
        iss: apiBaseUrl, aud: "openwork-desktop-connect", iat: now, exp: now + 600,
        jti: "rollback-security-token", v: 1, org: { name: "Synthetic workspace" },
        den: { baseUrl: "https://workspace.example.test", apiBaseUrl }, requireSignin: true,
      };
      function rawSign(claims: unknown) {
        const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid })).toString("base64url");
        const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
        const input = `${header}.${payload}`;
        return `${input}.${sign(null, Buffer.from(input), createPrivateKey(keys.privateKeyPem)).toString("base64url")}`;
      }
      const verify = (token: string) => legacy.verifyConnectLinkToken({ token, publicKeys, nowEpochSeconds: now });
      const stockClaims = connectLinkClaimsSchema.parse(base);
      const stockToken = signConnectLinkToken({ claims: stockClaims, privateKeyPem: keys.privateKeyPem, kid });
      const customClaims = { ...base, brand: { appName: dormant.brandAppName, logoUrl: dormant.brandLogoUrl, iconUrl: dormant.brandIconUrl } };
      const customToken = rawSign(customClaims);
      const currentSigned = current.verifyConnectLinkToken({ token: customToken, publicKeys, nowEpochSeconds: now });
      const exchangeUrl = buildConnectExchangeDeepLink("rollback_exchange_code_0123456789", apiBaseUrl);
      const resolveOld = (claims: unknown) => legacy.resolveConnectExchangeUrl(exchangeUrl, {
        mode: "exchange", nowEpochSeconds: now,
        fetcher: async () => Response.json({ claims }),
      });
      const currentExchange = await current.resolveConnectExchangeUrl(exchangeUrl, {
        mode: "exchange", nowEpochSeconds: now,
        fetcher: async () => Response.json({ claims: customClaims }),
      });
      const [header, , signature] = stockToken.split(".");
      const changedPayload = Buffer.from(JSON.stringify({ ...stockClaims, requireSignin: false })).toString("base64url");
      const currentSecurity = {
        tampered: current.verifyConnectLinkToken({ token: `${header}.${changedPayload}.${signature}`, publicKeys, nowEpochSeconds: now }),
        expired: current.verifyConnectLinkToken({ token: rawSign({ ...customClaims, exp: now - 61 }), publicKeys, nowEpochSeconds: now }),
        insecure: current.verifyConnectLinkToken({ token: rawSign({ ...customClaims, den: { ...base.den, baseUrl: "http://workspace.example.test" } }), publicKeys, nowEpochSeconds: now }),
        wrongIssuer: await current.resolveConnectExchangeUrl(exchangeUrl, {
          mode: "exchange", nowEpochSeconds: now,
          fetcher: async () => Response.json({ claims: { ...customClaims, iss: "https://other.example.test" } }),
        }),
      };
      const replayPath = seed.tmpPath("frozen-old-connect-replay.json");
      const guard = legacy.createConnectLinkReplayGuard({ filePath: replayPath });
      const replay = [await guard.remember(base.jti), await guard.remember(base.jti), await legacy.createConnectLinkReplayGuard({ filePath: replayPath }).has(base.jti)];
      return {
        stock: verify(stockToken), oldCustom: verify(customToken),
        missingBrand: verify(rawSign(base)), malformedBrand: verify(rawSign({ ...base, brand: { appName: "" } })),
        missingExchangeBrand: await resolveOld(base), malformedExchangeBrand: await resolveOld({ ...base, brand: { appName: "" } }),
        tampered: verify(`${header}.${changedPayload}.${signature}`),
        expired: verify(rawSign({ ...stockClaims, exp: now - 61 })),
        future: verify(rawSign({ ...stockClaims, iat: now + 61 })),
        unknownKey: legacy.verifyConnectLinkToken({ token: stockToken, publicKeys: {}, nowEpochSeconds: now }),
        insecure: verify(rawSign({ ...stockClaims, den: { ...base.den, baseUrl: "http://workspace.example.test" } })),
        wrongIssuer: await resolveOld({ ...stockClaims, iss: "https://other.example.test" }),
        expiredExchange: await resolveOld({ ...stockClaims, exp: now - 61 }),
        replay, currentSigned, currentExchange, currentSecurity,
        signedBootstrap: currentSigned.ok ? current.desktopBootstrapFromConnectClaims(currentSigned.claims) : null,
        exchangeBootstrap: currentExchange.ok ? current.desktopBootstrapFromConnectClaims(currentExchange.claims) : null,
        expectedBootstrap: { baseUrl: base.den.baseUrl, apiBaseUrl, requireSignin: true, whiteLabelEnabled: false },
      };
    },
  };
}
