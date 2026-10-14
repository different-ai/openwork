import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { desktopConnectRollback, STOCK_BRAND } from "../worlds/desktop-connect-rollback.ts";

// PR lane: real HTTP producer + scratch storage + frozen Electron protocol
// verifier. This deliberately does not claim packaged Electron/native OS smoke.
const test = spec.world(desktopConnectRollback, {
  resources: { surfaces: [], services: ["den"] },
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  timeout: 300_000,
});

test("Cloud OFF branding preserves rollback data and interoperates with frozen old desktops", { tags: ["agent-flow"] }, async ({ world, step, evidence }) => {
  await step("the old-client rejection witness and all trust boundaries remain intact; the new desktop ignores old custom identity", async () => {
    const result = await world.wireBoundaries();
    expect(result.stock).toMatchObject({ ok: true, claims: { brand: STOCK_BRAND } });
    expect(result.oldCustom).toMatchObject({ ok: true, claims: { brand: { appName: world.dormant.brandAppName } } });
    for (const rejected of [result.missingBrand, result.malformedBrand, result.missingExchangeBrand, result.malformedExchangeBrand]) {
      expect(rejected).toMatchObject({ ok: false, code: "malformed_claims" });
    }
    expect(result.tampered).toMatchObject({ ok: false, code: "bad_signature" });
    expect(result.expired).toMatchObject({ ok: false, code: "expired" });
    expect(result.future).toMatchObject({ ok: false, code: "not_yet_valid" });
    expect(result.unknownKey).toMatchObject({ ok: false, code: "unknown_kid" });
    expect(result.insecure).toMatchObject({ ok: false, code: "insecure_url" });
    expect(result.wrongIssuer).toMatchObject({ ok: false, code: "malformed_claims" });
    expect(result.expiredExchange).toMatchObject({ ok: false, code: "expired" });
    expect(result.replay).toEqual([true, false, true]);
    expect(result.currentSecurity.tampered).toMatchObject({ ok: false, code: "bad_signature" });
    expect(result.currentSecurity.expired).toMatchObject({ ok: false, code: "expired" });
    expect(result.currentSecurity.insecure).toMatchObject({ ok: false, code: "insecure_url" });
    expect(result.currentSecurity.wrongIssuer).toMatchObject({ ok: false, code: "malformed_claims" });
    expect(result.currentSigned).toMatchObject({ ok: true, transport: "signed" });
    expect(result.currentExchange).toMatchObject({ ok: true, transport: "exchange" });
    for (const customValue of [world.dormant.brandAppName, world.dormant.brandLogoUrl, world.dormant.brandIconUrl]) {
      expect(JSON.stringify(result.currentSigned)).not.toContain(customValue);
      expect(JSON.stringify(result.currentExchange)).not.toContain(customValue);
    }
    expect(result.signedBootstrap).toEqual(result.expectedBootstrap);
    expect(result.exchangeBootstrap).toEqual(result.expectedBootstrap);
    evidence.recordAssertionEvidence("Compatibility is not a trust-policy bypass", "Old verifier rejects missing/malformed brand, tamper, expiry, future issuance, unknown key, HTTP and exchange issuer mismatch; persisted replay guard still rejects reuse. New verifier accepts old custom claims but returns only connection bootstrap fields", true);
  });

  await step("new Den signed and keyless handoffs are accepted by the actual frozen old Electron verifier", async () => {
    const minted = await world.mint();
    expect(minted.config).toMatchObject({ appName: "OpenWork", logoUrl: null, iconUrl: null, whiteLabelEnabled: false });
    expect(minted.currentSigned).toMatchObject({ ok: true, claims: { brand: STOCK_BRAND, whiteLabelEnabled: false } });
    expect(minted.signed).toMatchObject({ ok: true, transport: "signed", claims: { brand: STOCK_BRAND, requireSignin: true } });
    const preview = await world.exchange(minted.exchangeUrl, "preview");
    expect(preview).toMatchObject({ ok: true, transport: "exchange", claims: { brand: STOCK_BRAND, requireSignin: true } });
    const exchanged = await world.exchange(minted.exchangeUrl, "exchange");
    expect(exchanged).toMatchObject({ ok: true, transport: "exchange", claims: { brand: STOCK_BRAND, requireSignin: true } });
    expect(await world.exchange(minted.exchangeUrl, "exchange")).toMatchObject({ ok: false, code: "replayed" });
    const stored = await world.stored();
    expect(stored.metadata).toMatchObject(world.dormant);
    expect(stored.assets).toEqual(world.initial.assets);
    evidence.recordAssertionEvidence("New backend → old desktop protocol compatibility", "Real Den install-link signed token, keyless preview and one-use exchange accepted by verbatim pre-gate Electron module; second exchange refused", true);
  });

  await step("Cloud OFF recognizes branding fields but denies mutations through the feature gate", async () => {
    const result = await world.disabledWrites();
    expect(result.fieldsStatus).toBe(404);
    expect(result.fieldsBody).toMatchObject({ error: "feature_disabled", feature: "whiteLabel" });
    expect(result.uploadStatus).toBe(404);
    expect(result.uploadBody).toMatchObject({ error: "feature_disabled", feature: "whiteLabel" });
    const stored = await world.stored();
    expect(stored.metadata).toMatchObject(world.dormant);
    expect(stored.assets).toEqual(world.initial.assets);
    evidence.recordAssertionEvidence("Cloud OFF blocks branding changes without deleting their sources", "Organization branding PATCH and asset POST both return 404 feature_disabled; saved branding and binary assets remain unchanged", true);
  });

  await step("an ordinary organization edit and metadata normalization retain dormant configuration and asset bytes", async () => {
    const result = await world.ordinaryEditAndRead();
    expect(result.editStatus).toBe(200);
    expect(result.readStatus).toBe(200);
    const stored = await world.stored();
    expect(stored.metadata).toMatchObject(world.dormant);
    expect(stored.metadata).toEqual({ ...world.initial.metadata, limits: { members: 5, workers: 1 }, requireSso: false });
    expect(stored.assets).toEqual(world.initial.assets);
    expect(stored.assets).toHaveLength(1);
    expect(stored.assets[0]?.bytesHex).toMatch(/^89504E470D0A1A0A/);
    // Member-facing projections must not reactivate dormant branding.
    expect(JSON.stringify(result.readBody)).not.toContain(world.dormant.brandAppName);
    expect(JSON.stringify(result.editBody)).not.toContain(world.dormant.brandAppName);
    evidence.recordAssertionEvidence("Rollback data survives real organization PATCH/read", "Dormant name, logo, icon, accent, asset references and binary asset row remain unchanged; legacy string limits normalize to integers", true);
  });
});
