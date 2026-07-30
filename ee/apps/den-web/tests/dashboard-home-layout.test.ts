import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

function readDashboardComponent(name: string) {
  return readFileSync(
    fileURLToPath(new URL(`../app/(den)/dashboard/_components/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("dashboard home layouts", () => {
  test("keeps the extensions download promotion reusable without rendering it on the admin overview", () => {
    const overview = readDashboardComponent("dashboard-overview-screen.tsx");
    const promotion = readDashboardComponent("extensions-download-promo.tsx");

    expect(overview).not.toContain("Download the app to unlock extensions");
    expect(overview).not.toContain("ExtensionsDownloadPromo");
    expect(promotion).toContain("export function ExtensionsDownloadPromo");
    expect(promotion).toContain("Download the app to unlock extensions");
  });

  test("retains the organization download card on the admin overview", () => {
    const overview = readDashboardComponent("dashboard-overview-screen.tsx");
    const downloadCard = readDashboardComponent("organization-download-card.tsx");

    expect(overview).toContain("<OrganizationDownloadCard");
    expect(downloadCard).toContain('data-testid="workspace-install-card"');
    expect(downloadCard).toContain('data-testid="workspace-install-open"');
  });

  test("member dashboard is a single download action, not a resource inventory", () => {
    const member = readDashboardComponent("member-dashboard-screen.tsx");

    expect(member).toContain('data-testid="member-dashboard"');
    expect(member).toContain('data-testid="member-download-app"');
    expect(member).toContain('data-testid="member-copy-install-link"');
    // The install link is minted by the workspace's own den, so the same
    // action works for OpenWork Cloud and self-hosted orgs.
    expect(member).toContain("createOrganizationInstallLink");
    expect(member).toContain('"openwork://open"');
    expect(member).not.toContain("useOrgLlmProviders");
    expect(member).not.toContain("useMarketplaces");
    expect(member).not.toContain("usePlugins");
    expect(member).not.toContain('requestJson("/v1/inference"');
    expect(member).not.toContain("Paper");
    expect(member).not.toContain('bg-[#07192C]');
  });
});
