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

  test("retains the organization download card on both dashboard experiences", () => {
    const overview = readDashboardComponent("dashboard-overview-screen.tsx");
    const member = readDashboardComponent("member-dashboard-screen.tsx");
    const downloadCard = readDashboardComponent("organization-download-card.tsx");

    expect(overview).toContain("<OrganizationDownloadCard");
    expect(member).toContain("<OrganizationDownloadCard");
    expect(downloadCard).toContain('data-testid="organization-download-card"');
    expect(downloadCard).toContain('data-testid="organization-download-button"');
  });

  test("uses a compact member resource overview backed by member-scoped data", () => {
    const member = readDashboardComponent("member-dashboard-screen.tsx");

    expect(member).toContain('data-testid="member-dashboard"');
    expect(member).toContain('data-testid="member-resource-overview"');
    expect(member).toContain('data-testid="member-resource-card"');
    expect(member).toContain('useOrgLlmProviders(orgId, { scope: "usable" })');
    expect(member).toContain("useMarketplaces()");
    expect(member).toContain("usePlugins()");
    expect(member).toContain('requestJson("/v1/inference"');
    expect(member).not.toContain("Paper");
    expect(member).not.toContain('bg-[#07192C]');
  });
});
