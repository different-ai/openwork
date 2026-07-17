declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  not: { toBe: (expected: unknown) => void };
};

import {
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
});
