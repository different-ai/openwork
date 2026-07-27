import { describe, expect, test } from "bun:test";

import { enterpriseActivationRequired } from "../src/app/lib/enterprise-activation";
import { parseDenAuthDeepLink } from "../src/app/lib/openwork-links";

const publicDistribution = {
  flavor: "public" as const,
  appName: "OpenWork",
  appIdentifier: "com.differentai.openwork",
  protocolScheme: "openwork",
  requireSignin: false,
};

const enterpriseDistribution = {
  flavor: "enterprise" as const,
  appName: "OpenWork Enterprise",
  appIdentifier: "com.differentai.openwork.enterprise",
  protocolScheme: "openwork",
  requireSignin: true,
};

describe("enterprise desktop activation", () => {
  test("never gates the public distribution", () => {
    expect(enterpriseActivationRequired(publicDistribution, {})).toBe(false);
  });

  test("gates enterprise until a complete activation is persisted", () => {
    expect(enterpriseActivationRequired(enterpriseDistribution, {})).toBe(true);
    expect(enterpriseActivationRequired(enterpriseDistribution, {
      enterpriseActivation: {
        activatedAt: "2026-07-27T12:00:00.000Z",
        denBaseUrl: "https://app.openworklabs.com",
      },
    })).toBe(false);
  });

  test("uses the standard Den auth deep-link shape", () => {
    expect(parseDenAuthDeepLink(
      "openwork://den-auth?grant=one-time-grant&denBaseUrl=https%3A%2F%2Fapp.openworklabs.com",
    )).toEqual({
      grant: "one-time-grant",
      denBaseUrl: "https://app.openworklabs.com",
    });
  });
});
