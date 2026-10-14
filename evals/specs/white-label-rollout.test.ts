import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { desktopConnectRollback, selfHostedBranding, STOCK_BRAND } from "../worlds/desktop-connect-rollback.ts";

const options = {
  resources: { surfaces: [], services: ["den"] },
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  timeout: 300_000,
} satisfies Parameters<typeof spec.world>[1];
const cloud = spec.world(desktopConnectRollback, options);
const selfHosted = spec.world(selfHostedBranding, options);

selfHosted("self-hosted branding is enabled by default and frozen old desktops accept custom links", async ({ world, evidence }) => {
  expect((await world.state()).body).toMatchObject({ features: { whiteLabel: true } });
  const minted = await world.mint();
  const brand = { appName: world.dormant.brandAppName, logoUrl: world.dormant.brandLogoUrl, iconUrl: world.dormant.brandIconUrl };
  expect(minted.config).toMatchObject(brand);
  expect(minted.currentSigned).toMatchObject({ ok: true, claims: { brand, whiteLabelEnabled: true } });
  expect(minted.signed).toMatchObject({ ok: true, claims: { brand } });
  expect(await world.exchange(minted.exchangeUrl, "exchange")).toMatchObject({ ok: true, claims: { brand } });
  expect(await world.stored()).toEqual(world.initial);
  evidence.recordAssertionEvidence("Self-hosted ON → frozen legacy consumer", "Real signed and exchange links retain custom identity; original storage is unchanged", true);
});

cloud("new cloud metadata cannot self-enable; explicit disable/enable preserves branding and bytes", async ({ world, evidence }) => {
  const initial = await world.state();
  expect(initial.body).toMatchObject({ features: { whiteLabel: false } });
  expect(initial.override).toBeNull();
  expect(initial.cutoff).not.toBeNull();
  await world.restart();
  expect((await world.state()).body).toMatchObject({ features: { whiteLabel: false } });
  expect((await world.state()).override).toBeNull();
  expect((await world.mint()).currentSigned).toMatchObject({ ok: true, claims: { brand: STOCK_BRAND, whiteLabelEnabled: false } });
  await world.setEnabled(true);
  expect((await world.mint()).currentSigned).toMatchObject({ ok: true, claims: { brand: { appName: world.dormant.brandAppName }, whiteLabelEnabled: true } });
  await world.setEnabled(false);
  expect((await world.mint()).config).toMatchObject(STOCK_BRAND);
  // The admin endpoint maintains its legacy capability mirror. Only that
  // authority field may change; branding, unrelated data and bytes must not.
  expect(await world.stored()).toEqual({ ...world.initial, metadata: { ...world.initial.metadata, capabilities: { whiteLabel: false } } });
  await world.setEnabled(true);
  expect((await world.mint()).config).toMatchObject({ appName: world.dormant.brandAppName, logoUrl: world.dormant.brandLogoUrl });
  expect(await world.stored()).toEqual({ ...world.initial, metadata: { ...world.initial.metadata, capabilities: { whiteLabel: true } } });
  evidence.recordAssertionEvidence("Explicit feature authority, not metadata", "New cloud metadata remains OFF after real startup; admin enable/disable changes projections and the legacy capability mirror without touching branding, unrelated metadata or asset bytes", true);
});

cloud("automatic startup grandfathers only configured historical cloud organizations and kill wins", async ({ world, evidence }) => {
  await world.restartWithHistoricalOrganization();
  const grandfathered = await world.state();
  const cutoff = grandfathered.cutoff;
  expect(cutoff).not.toBeNull();
  expect(grandfathered.body).toMatchObject({ features: { whiteLabel: true } });
  expect(grandfathered.override).toMatchObject({ enabled: 1, source: "migration" });
  const custom = await world.mint();
  expect(custom.currentSigned).toMatchObject({ ok: true, claims: { brand: { appName: world.dormant.brandAppName }, whiteLabelEnabled: true } });
  expect(custom.signed).toMatchObject({ ok: true, claims: { brand: { appName: world.dormant.brandAppName } } });
  expect(await world.exchange(custom.exchangeUrl, "exchange")).toMatchObject({ ok: true, claims: { brand: { appName: world.dormant.brandAppName } } });
  await world.setKilled(true);
  await world.restart();
  expect((await world.state()).body).toMatchObject({ features: { whiteLabel: false } });
  expect((await world.mint()).currentSigned).toMatchObject({ ok: true, claims: { brand: STOCK_BRAND, whiteLabelEnabled: false } });
  expect((await world.state()).override).toMatchObject({ enabled: 1, source: "migration" });
  await world.setKilled(false);
  expect((await world.state()).body).toMatchObject({ features: { whiteLabel: true } });
  await world.setEnabled(null);
  expect((await world.state()).body).toMatchObject({ features: { whiteLabel: false } });
  expect((await world.state()).override).toBeNull();
  await world.restart();
  expect((await world.state()).body).toMatchObject({ features: { whiteLabel: false } });
  expect((await world.state()).override).toBeNull();
  expect((await world.state()).cutoff).toEqual(cutoff);
  expect(await world.stored()).toEqual(world.initial);
  evidence.recordAssertionEvidence("Real same-database one-time startup migration", "Historical configured org receives a migration override only at cutover; kill wins, admin Use default removes it permanently across restart, and metadata and bytes remain unchanged", true);
});

cloud("first cutover never overwrites a pre-existing explicit admin OFF", async ({ world, evidence }) => {
  await world.setEnabled(false);
  await world.restartWithHistoricalOrganization();
  const state = await world.state();
  expect(state.cutoff).not.toBeNull();
  expect(state.body).toMatchObject({ features: { whiteLabel: false } });
  expect(state.override).toMatchObject({ enabled: 0, source: "platform" });
  await world.restart();
  expect((await world.state()).override).toEqual(state.override);
  expect((await world.state()).cutoff).toEqual(state.cutoff);
  expect((await world.mint()).config).toMatchObject(STOCK_BRAND);
  expect(await world.stored()).toEqual(world.initial);
  evidence.recordAssertionEvidence("Pre-existing admin OFF survives first cutover", "Startup creates the rollout marker without replacing the organization's explicit false override or touching its branding bytes", true);
});

cloud("branding forged after cutover cannot promote even a pre-cutoff organization", async ({ world, evidence }) => {
  await world.restartWithHistoricalOrganization(false);
  const state = await world.state();
  expect(state.body).toMatchObject({ features: { whiteLabel: false } });
  expect(state.override).toBeNull();
  await world.injectBrandMetadata();
  await world.restart();
  expect((await world.state()).body).toMatchObject({ features: { whiteLabel: false } });
  expect((await world.state()).override).toBeNull();
  expect((await world.state()).cutoff).toEqual(state.cutoff);
  expect((await world.mint()).currentSigned).toMatchObject({ ok: true, claims: { brand: STOCK_BRAND, whiteLabelEnabled: false } });
  expect(await world.stored()).toEqual(world.initial);
  evidence.recordAssertionEvidence("Cutover is one-time, not metadata authority", "An old unconfigured organization remains OFF when branding metadata is injected after cutover and the real API is restarted", true);
});
