import { expect, test } from "bun:test";
import { MODEL_ACCESS_POLICY_KEYS, desktopCapabilityConfig, desktopPolicyKeys, normalizeDesktopConfig, restrictedDesktopPolicyValue } from "@openwork/types/den/desktop-policies";
import { checkDesktopAppRestriction } from "../src/app/cloud/desktop-app-restrictions";
import { filterEntitledModelOptions, isProviderAddRestrictedByDesktopPolicy } from "../src/react-app/domains/connections/provider-auth/provider-policy";
import { outboundEgressAllowed } from "../src/app/lib/enterprise-activation";
import type { DesktopDistributionInfo } from "../src/app/lib/desktop";

const enforced = new Set<string>(MODEL_ACCESS_POLICY_KEYS);

test("model access is enforced; every other desktop flag stays advisory, and absent config restricts nothing", () => {
  expect([...enforced]).toEqual(["allowCustomProviders"]);
  for (const config of [null, undefined, {}]) {
    for (const restriction of desktopPolicyKeys) expect(checkDesktopAppRestriction({ config, restriction })).toBe(false);
  }
  for (const restriction of desktopPolicyKeys) {
    const restricted = restrictedDesktopPolicyValue[restriction] === false;
    expect(checkDesktopAppRestriction({ config: restrictedDesktopPolicyValue, restriction })).toBe(restricted && enforced.has(restriction));
  }
});

test("runtime projection keeps only the provider restrictions, and preserves Cloud entitlements, allowed versions and source config", () => {
  const config = normalizeDesktopConfig({
    ...restrictedDesktopPolicyValue,
    allowedDesktopVersions: ["0.18.46"], execution: { commands: "deny" },
    connectEnabled: false, automationsEnabled: false, dashboardEnabled: false,
    brandAppName: "Example", showWelcomePage: false,
  });
  const before = JSON.stringify(config);
  const projected = desktopCapabilityConfig(config);
  expect(projected).toMatchObject({ connectEnabled: false, automationsEnabled: false, dashboardEnabled: false, brandAppName: "Example", showWelcomePage: false });
  expect(projected.execution).toBeUndefined();
  expect(projected.allowedDesktopVersions).toEqual(["0.18.46"]);
  for (const key of desktopPolicyKeys) {
    if (enforced.has(key)) expect(projected[key]).toBe(config[key]);
    else if (key !== "showWelcomePage") expect(projected[key]).toBeUndefined();
  }
  expect(JSON.stringify(config)).toBe(before);
});

test("policy readiness never delays activated desktop egress; activation remains required", () => {
  const distribution: DesktopDistributionInfo = {
    flavor: "enterprise", requireActivation: true, requireSignin: true,
    appName: "OpenWork Enterprise", appIdentifier: "com.example.openwork", protocolScheme: "openwork",
  };
  expect(outboundEgressAllowed(distribution, { requireActivation: true }, { desktopConfigLoading: true })).toBe(false);
  expect(outboundEgressAllowed(distribution, { requireActivation: true, enterpriseActivation: {
    activatedAt: "2026-09-17T00:00:00Z", denBaseUrl: "https://example.com",
  } }, { desktopConfigLoading: true })).toBe(true);
});

test("with \"Only models you provide\", adding a personal provider is blocked and the picker keeps managed models; Zen is unchanged", () => {
  for (const allowZenModel of [true, false]) {
    const config = { allowCustomProviders: false, allowZenModel };
    const checkRestriction = ({ restriction }: { restriction: Parameters<typeof checkDesktopAppRestriction>[0]["restriction"] }) => checkDesktopAppRestriction({ config, restriction });
    for (const providerId of ["anthropic", "ollama", "personal"]) expect(isProviderAddRestrictedByDesktopPolicy({ providerId, checkRestriction })).toBe(true);
    for (const providerId of ["lpr_team", "ipr_gateway", "openwork", "opencode"]) expect(isProviderAddRestrictedByDesktopPolicy({ providerId, checkRestriction })).toBe(false);
    const options = ["anthropic", "lpr_team", "ipr_gateway", "openwork", "opencode"].map((providerID) => ({ providerID }));
    expect(filterEntitledModelOptions(options, { restrictToCloud: true, checkRestriction }).map((option) => option.providerID))
      .toEqual(["lpr_team", "ipr_gateway", "openwork", "opencode"]);
  }
  // Organizations without the setting see no change.
  const open = ({ restriction }: { restriction: Parameters<typeof checkDesktopAppRestriction>[0]["restriction"] }) => checkDesktopAppRestriction({ config: {}, restriction });
  expect(isProviderAddRestrictedByDesktopPolicy({ providerId: "anthropic", checkRestriction: open })).toBe(false);
});
