import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  getSafeMemberReturnTo,
  resolveMemberAuthGuardDecision,
  resolveMemberReturnTo,
} from "../app/(den)/_lib/member-auth-routing";

const authPanelPath = fileURLToPath(
  new URL("../app/(den)/_components/auth-panel.tsx", import.meta.url),
);

type GuardInput = Parameters<typeof resolveMemberAuthGuardDecision>[0];

const signedOutInstall: GuardInput = {
  route: "/install",
  hasInstallToken: false,
  setupStatus: "complete",
  authCheckStatus: "ready",
  signedIn: false,
  singleOrgSsoConfigured: true,
  singleOrgSlug: "default",
};

describe("Den auth landing contract", () => {
  // Signup layout and responsive visuals are exercised by signup-workspace-intent.e2e.test.ts.
  test("starts the email-first panel with the approved heading", () => {
    const source = readFileSync(authPanelPath, "utf8");

    expect(source).toContain('title: "Start using OpenWork"');
    expect(source).toContain("Enter your email and we'll send you to the right sign-in step.");
    expect(source).not.toContain("Continue to OpenWork.");
  });

  test("signed-in desktop handoff shows account email and a pasteable link by default", () => {
    const source = readFileSync(authPanelPath, "utf8");

    expect(source).toContain('data-testid="desktop-signed-in-handoff"');
    expect(source).toContain("Logged in as");
    expect(source).toContain("showCopyLinkByDefault");
    expect(source).toContain('data-testid="desktop-handoff-copy-link"');
    expect(source).toContain("desktopAuthRequested && user && !setupPending");
    expect(source).toContain("Retry opening OpenWork");
    expect(source).toContain("onClick={retryDesktopAuthHandoff}");
    expect(source).not.toContain("showAuthFeedback && authInfo && !authError");
  });

  for (const requireSso of [false, true]) {
    test(`configured and verified SSO redirects member routes regardless of enforcement=${requireSso}`, () => {
      expect(resolveMemberAuthGuardDecision(signedOutInstall)).toBe("sso");
      expect(resolveMemberAuthGuardDecision({ ...signedOutInstall, route: "/setup" })).toBe("sso");
    });
  }

  for (const configurationState of ["missing", "unverified"]) {
    test(`${configurationState} SSO uses generic sign-in`, () => {
      expect(resolveMemberAuthGuardDecision({ ...signedOutInstall, singleOrgSsoConfigured: false })).toBe("sign-in");
    });
  }

  test("first-administrator bootstrap remains public while completed setup requires auth", () => {
    expect(resolveMemberAuthGuardDecision({ ...signedOutInstall, route: "/setup", setupStatus: "available" })).toBe("render");
    expect(resolveMemberAuthGuardDecision({ ...signedOutInstall, route: "/setup", setupStatus: "unavailable" })).toBe("render");
    expect(resolveMemberAuthGuardDecision({ ...signedOutInstall, route: "/setup", signedIn: true })).toBe("render");
    expect(resolveMemberAuthGuardDecision({ ...signedOutInstall, signedIn: true })).toBe("render");
    expect(resolveMemberAuthGuardDecision({ ...signedOutInstall, route: "/setup" })).toBe("sso");
  });

  test("valid token installs stay public while unresolved and failed auth checks never navigate", () => {
    expect(resolveMemberAuthGuardDecision({ ...signedOutInstall, hasInstallToken: true })).toBe("render");
    expect(resolveMemberAuthGuardDecision({ ...signedOutInstall, authCheckStatus: "checking" })).toBe("wait");
    expect(resolveMemberAuthGuardDecision({ ...signedOutInstall, authCheckStatus: "error" })).toBe("error");
  });

  test("return targets are relative, allowlisted, and contain no token-bearing query", () => {
    expect(getSafeMemberReturnTo("/install")).toBe("/install");
    expect(getSafeMemberReturnTo("/setup")).toBe("/setup");
    expect(getSafeMemberReturnTo("https://attacker.invalid/install")).toBeNull();
    expect(getSafeMemberReturnTo("//attacker.invalid/install")).toBeNull();
    expect(getSafeMemberReturnTo("/\\attacker.invalid/install")).toBeNull();
    expect(getSafeMemberReturnTo("/install?token=secret")).toBeNull();
    expect(getSafeMemberReturnTo("/setup#complete")).toBeNull();
    expect(getSafeMemberReturnTo("/dashboard")).toBeNull();
  });

  test("desktop and web handoffs take priority over member return targets", () => {
    expect(resolveMemberReturnTo("/install", false)).toBe("/install");
    expect(resolveMemberReturnTo("/install", true)).toBeNull();
  });
});
