import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const memberDashboardPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/member-dashboard-screen.tsx", import.meta.url),
);

function readMemberDashboardSource() {
  return readFileSync(memberDashboardPath, "utf8");
}

describe("member dashboard install contract", () => {
  test("opens the authenticated install page without minting a token", () => {
    const source = readMemberDashboardSource();

    expect(source).toContain('router.push("/install")');
    expect(source).toContain("Get OpenWork");
    expect(source).not.toContain("/install-links");
    expect(source).not.toContain("token=");
    expect(source).not.toContain("createOrganizationInstallLink");
    expect(source).not.toContain("installTokenFromPageUrl");
    expect(source).not.toContain("/v1/install-config?token=");
  });

  test("does not expose a shareable token-minting fallback", () => {
    const source = readMemberDashboardSource();

    expect(source).not.toContain('data-testid="member-copy-install-link"');
    expect(source).not.toContain("mintInstallLink");
  });
});
