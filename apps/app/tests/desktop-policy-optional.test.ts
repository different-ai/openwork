import { expect, test } from "bun:test";
import { desktopCapabilityConfig, desktopPolicyKeys, normalizeDesktopConfig, restrictedDesktopPolicyValue } from "@openwork/types/den/desktop-policies";
import { checkDesktopAppRestriction } from "../src/app/cloud/desktop-app-restrictions";
import { outboundEgressAllowed } from "../src/app/lib/enterprise-activation";
import type { DesktopDistributionInfo } from "../src/app/lib/desktop";

test("all desktop flags are advisory, including absent config", () => {
  for (const config of [null, undefined, {}, restrictedDesktopPolicyValue]) {
    for (const restriction of desktopPolicyKeys) expect(checkDesktopAppRestriction({ config, restriction })).toBe(false);
  }
});

test("runtime projection removes desktop restrictions but preserves Cloud entitlements, allowed versions and source config", () => {
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
  for (const key of desktopPolicyKeys) if (key !== "showWelcomePage") expect(projected[key]).toBeUndefined();
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
