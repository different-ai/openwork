declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
  not: { toBe: (expected: unknown) => void };
};

import {
  bootstrapBrandingFromDesktopConfig,
  bootstrapBrandingNeedsSync,
  brandIconReconcileAction,
  hasWorkspaceBranding,
  workspaceBrandingFingerprint,
} from "./workspace-branding-restart";

describe("workspace branding restart", () => {
  test("detects every supported branding field", () => {
    expect(hasWorkspaceBranding({ brandAppName: "Acme" })).toBe(true);
    expect(hasWorkspaceBranding({ brandLogoUrl: "https://example.com/logo.png" })).toBe(true);
    expect(hasWorkspaceBranding({ brandIconUrl: "https://example.com/icon.png" })).toBe(true);
    expect(hasWorkspaceBranding({ brandAccentColor: "blue" })).toBe(true);
    expect(hasWorkspaceBranding({})).toBe(false);
  });

  test("fingerprints the organization and all branding fields", () => {
    const first = workspaceBrandingFingerprint("org-1", { brandIconUrl: "https://example.com/one.png" });
    const repeated = workspaceBrandingFingerprint("org-1", { brandIconUrl: "https://example.com/one.png" });
    const changed = workspaceBrandingFingerprint("org-1", { brandIconUrl: "https://example.com/two.png" });

    expect(first).toBe(repeated);
    expect(first).not.toBe(changed);
  });

  test("maps cleared desktop branding to null bootstrap fields", () => {
    expect(bootstrapBrandingFromDesktopConfig({
      brandAppName: "Acme",
      brandLogoUrl: "https://example.com/logo.png",
      brandIconUrl: "https://example.com/icon.png",
    })).toEqual({
      brandAppName: "Acme",
      brandLogoUrl: "https://example.com/logo.png",
      brandIconUrl: "https://example.com/icon.png",
    });
    expect(bootstrapBrandingFromDesktopConfig({})).toEqual({
      brandAppName: null,
      brandLogoUrl: null,
      brandIconUrl: null,
    });
  });

  test("detects when bootstrap still holds a cleared brand icon or wordmark", () => {
    expect(bootstrapBrandingNeedsSync(
      { brandIconUrl: "https://example.com/icon.png", brandLogoUrl: "https://example.com/logo.png" },
      {},
    )).toBe(true);
    expect(bootstrapBrandingNeedsSync(
      { brandIconUrl: "https://example.com/icon.png" },
      { brandIconUrl: "https://example.com/icon.png" },
    )).toBe(false);
    expect(bootstrapBrandingNeedsSync(
      {},
      { brandLogoUrl: "https://example.com/logo.png" },
    )).toBe(true);
  });

  test("reconcile clears a shell icon the org no longer configures", () => {
    expect(brandIconReconcileAction({}, { applied: true })).toEqual({ apply: null });
  });

  test("reconcile applies a configured icon the shell never applied", () => {
    expect(brandIconReconcileAction(
      { brandIconUrl: "https://example.com/icon.png" },
      { applied: false },
    )).toEqual({ apply: "https://example.com/icon.png" });
  });

  test("reconcile is a no-op when the shell already matches the config", () => {
    expect(brandIconReconcileAction({}, { applied: false })).toBe(null);
    expect(brandIconReconcileAction(
      { brandIconUrl: "https://example.com/icon.png" },
      { applied: true },
    )).toBe(null);
  });

  test("reconcile is a no-op without a shell bridge", () => {
    expect(brandIconReconcileAction({}, null)).toBe(null);
    expect(brandIconReconcileAction({ brandIconUrl: "https://example.com/icon.png" }, null)).toBe(null);
  });
});
