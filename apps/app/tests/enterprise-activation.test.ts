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
const providersSource = readFileSync(
  new URL("../src/react-app/shell/providers.tsx", import.meta.url),
  "utf8",
);
const connectConfirmDialogSource = readFileSync(
  new URL("../src/react-app/domains/cloud/connect-confirm-dialog.tsx", import.meta.url),
  "utf8",
);
const ditherBackdropSource = readFileSync(
  new URL("../src/components/dither-backdrop.tsx", import.meta.url),
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

  test("keeps the Enterprise artifact authoritative over bootstrap opt-out", () => {
    expect(enterpriseActivationRequired(enterpriseDistribution, {
      requireActivation: false,
    })).toBe(true);
  });

  test("lets desktop-bootstrap.json enable activation for other artifacts", () => {
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

  test("evaluates activation before rendering the sign-in gate", () => {
    const activationStart = appRootSource.indexOf("<EnterpriseActivationGate>");
    const activationEnd = appRootSource.indexOf("</EnterpriseActivationGate>");
    const signInStart = appRootSource.indexOf("<DenSigninGate>");
    const signInEnd = appRootSource.indexOf("</DenSigninGate>");

    expect(activationStart).toBeGreaterThan(-1);
    expect(signInStart).toBeGreaterThan(activationStart);
    expect(signInEnd).toBeGreaterThan(signInStart);
    expect(activationEnd).toBeGreaterThan(signInEnd);
  });

  test("keeps the branded connect-link activation consumer mounted before activation", () => {
    // The pre-activation branch keeps ConnectLinkProvider mounted (the branded
    // connect-link consumer) and also provides the contexts AppRoot-level
    // consumers need — DesktopUpdaterProvider's useUpdater() reads Local and
    // DesktopConfig contexts before activation completes (#4482).
    const activationBranch = providersSource.slice(
      providersSource.indexOf("if (activationRequired)"),
      providersSource.indexOf("<DesktopRuntimeBoot"),
    );
    expect(activationBranch).toContain("<ConnectLinkProvider>");
    expect(activationBranch).toContain("<DesktopConfigProvider>");
    expect(activationBranch).toContain("<LocalProvider>");
    expect(connectConfirmDialogSource).toContain(
      "const trustedBrandUrl = transport ? claims?.brand.iconUrl ?? claims?.brand.logoUrl : null;",
    );
  });

  test("matches the desktop login gate and offers actionable sign-in", () => {
    for (const marker of [
      "<DitherBackdrop />",
      'className="w-full max-w-[720px] rounded-3xl border border-border bg-background',
    ]) {
      expect(signInSurfaceSource).toContain(marker);
      expect(activationGateSource).toContain(marker);
    }
    // The shared backdrop keeps the Paper dither spec and skips the shader without WebGL2.
    for (const marker of ['type="2x2"', "size={20.3}", "scale={1.19}", "frame={264559.21}", 'getContext("webgl2")']) {
      expect(ditherBackdropSource).toContain(marker);
    }
    expect(activationGateSource).toContain('id="organization-server-input"');
    expect(activationGateSource).toContain('data-testid="organization-server-input"');
    expect(activationGateSource).toContain('data-testid="organization-server-confirm"');
    expect(activationGateSource).toContain("Connect this app to");
    expect(activationGateSource).toContain("binds OpenWork Enterprise to it");
    expect(activationGateSource).toContain("Continue in browser");
    expect(activationGateSource).not.toContain('htmlFor="enterprise-openwork-link"');
    expect(activationGateSource).not.toContain("OpenWork link");
    expect(activationGateSource).not.toContain("enterprise-openwork-link-connect");
    expect(activationGateSource).toContain("Link this app to your organization");
    expect(activationGateSource).toContain("Enter your workspace address — the page where you downloaded this app. Sign-in finishes in your browser and returns here.");
    expect(activationGateSource).toContain("const pastedLink = parseManualAuthInput(serverInput);");
    expect(activationGateSource).toContain("{pendingConfirmation ? null : (");
    expect(activationGateSource).not.toContain("Have an OpenWork link");
    expect(activationGateSource).not.toContain("Use workspace address instead");
    expect(activationGateSource).not.toContain("manualAuthOpen");
    expect(activationGateSource).not.toMatch(/(?:paste|hide) sign-in code/i);
    expect(activationGateSource).not.toContain("Sign-in link or one-time code");
    expect(activationGateSource).not.toContain("Waiting for your organization");
  });

  test("reuses the activated enterprise Den URL when signing in again", () => {
    expect(forcedSignInPageSource).toContain(
      "bootstrap.enterpriseActivation?.denBaseUrl ||",
    );
  });
});
