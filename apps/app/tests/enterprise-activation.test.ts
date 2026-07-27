import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { enterpriseActivationRequired } from "../src/app/lib/enterprise-activation";
import { parseDenAuthDeepLink } from "../src/app/lib/openwork-links";

const appRootSource = readFileSync(
  new URL("../src/react-app/shell/app-root.tsx", import.meta.url),
  "utf8",
);
const activationGateSource = readFileSync(
  new URL("../src/react-app/domains/cloud/enterprise-activation-gate.tsx", import.meta.url),
  "utf8",
);
const signInSurfaceSource = readFileSync(
  new URL("../src/react-app/domains/cloud/den-signin-surface.tsx", import.meta.url),
  "utf8",
);
const forcedSignInPageSource = readFileSync(
  new URL("../src/react-app/domains/cloud/forced-signin-page.tsx", import.meta.url),
  "utf8",
);

const publicDistribution = {
  flavor: "public" as const,
  appName: "OpenWork",
  appIdentifier: "com.differentai.openwork",
  protocolScheme: "openwork",
  requireSignin: false,
  requireActivation: false,
};

const enterpriseDistribution = {
  flavor: "enterprise" as const,
  appName: "OpenWork Enterprise",
  appIdentifier: "com.differentai.openwork",
  protocolScheme: "openwork",
  requireSignin: true,
  requireActivation: true,
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

  test("lets desktop-bootstrap.json override either artifact default", () => {
    expect(enterpriseActivationRequired(enterpriseDistribution, {
      requireActivation: false,
    })).toBe(false);
    expect(enterpriseActivationRequired(publicDistribution, {
      requireActivation: true,
    })).toBe(true);
  });

  test("uses the standard Den auth deep-link shape", () => {
    expect(parseDenAuthDeepLink(
      "openwork://den-auth?grant=one-time-grant&denBaseUrl=https%3A%2F%2Fapp.openworklabs.com",
    )).toEqual({
      grant: "one-time-grant",
      denBaseUrl: "https://app.openworklabs.com",
    });
  });

  test("does not let the boot overlay cover the activation page", () => {
    const gateStart = appRootSource.indexOf("<EnterpriseActivationGate>");
    const gateEnd = appRootSource.indexOf("</EnterpriseActivationGate>");
    const overlay = appRootSource.indexOf("<LoadingOverlay />");

    expect(gateStart).toBeGreaterThan(-1);
    expect(gateEnd).toBeGreaterThan(gateStart);
    expect(overlay).toBeGreaterThan(gateStart);
    expect(overlay).toBeLessThan(gateEnd);
  });

  test("matches the desktop login gate without guessing a Den portal URL", () => {
    for (const marker of [
      'type="2x2"',
      "size={20.3}",
      "scale={1.19}",
      "frame={264559.21}",
      'className="w-full max-w-[720px] rounded-3xl border border-border bg-background',
    ]) {
      expect(signInSurfaceSource).toContain(marker);
      expect(activationGateSource).toContain(marker);
    }
    expect(activationGateSource).not.toContain("Open Den portal");
    expect(activationGateSource).not.toContain("openDesktopUrl");
  });

  test("reuses the activated enterprise Den URL when signing in again", () => {
    expect(forcedSignInPageSource).toContain(
      "bootstrap.enterpriseActivation?.denBaseUrl ||",
    );
  });
});
