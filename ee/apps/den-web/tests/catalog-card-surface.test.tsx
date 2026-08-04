import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import {
  CatalogIdentityTile,
  getCatalogMonogram,
} from "../app/(den)/dashboard/_components/catalog-identity-tile";

function readDashboardComponent(name: string) {
  return readFileSync(
    fileURLToPath(new URL(`../app/(den)/dashboard/_components/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("Den catalog identity", () => {
  test("derives a monogram from the first alphanumeric character", () => {
    expect(getCatalogMonogram("Engineering Marketplace")).toBe("E");
    expect(getCatalogMonogram("test")).toBe("T");
    expect(getCatalogMonogram("  ben private")).toBe("B");
    expect(getCatalogMonogram("4-day sprint")).toBe("4");
    expect(getCatalogMonogram("···")).toBe("?");
  });

  test("renders the real logo when the marketplace has one", () => {
    const markup = renderToStaticMarkup(
      createElement(CatalogIdentityTile, {
        name: "Engineering Marketplace",
        logoUrl: "https://example.test/logo.png",
      }),
    );

    expect(markup).toContain('src="https://example.test/logo.png"');
    expect(markup).toContain('alt="Engineering Marketplace logo"');
  });

  test("falls back to a monogram when there is no logo", () => {
    const markup = renderToStaticMarkup(
      createElement(CatalogIdentityTile, { name: "Engineering Marketplace" }),
    );

    expect(markup).not.toContain("<img");
    expect(markup).toContain(">E<");
  });

  test("keeps the same tile geometry across directory and detail sizes", () => {
    const directory = renderToStaticMarkup(
      createElement(CatalogIdentityTile, { name: "Shared plugin", size: "sm" }),
    );
    const detail = renderToStaticMarkup(
      createElement(CatalogIdentityTile, { name: "Shared plugin", size: "lg" }),
    );

    expect(directory).toContain("h-10 w-10");
    expect(detail).toContain("h-12 w-12");
    expect(directory).toContain(">S<");
    expect(detail).toContain(">S<");
  });

  test("preserves card content, relationships, actions, and navigation on all four surfaces", () => {
    const marketplaces = readDashboardComponent("marketplaces-screen.tsx");
    const marketplaceDetail = readDashboardComponent("marketplace-detail-screen.tsx");
    const plugins = readDashboardComponent("plugins-screen.tsx");
    const pluginDetail = readDashboardComponent("plugin-detail-screen.tsx");

    expect(marketplaces).toContain("getMarketplaceRoute(orgSlug, marketplace.id)");
    expect(marketplaces).toContain("marketplace.description");
    expect(marketplaces).toContain("marketplace.pluginCount");

    expect(plugins).toContain("getPluginRoute(orgSlug, plugin.id)");
    expect(plugins).toContain("plugin.description");
    expect(plugins).toContain("plugin.marketplaces");
    expect(plugins).toContain("getPluginPartsSummary(plugin)");

    expect(marketplaceDetail).toContain("getPluginRoute(orgSlug, plugin.id)");
    expect(marketplaceDetail).toContain("orderedCountEntries");
    expect(marketplaceDetail).toContain("cloudReadinessLabel(readiness.state)");
    expect(marketplaceDetail).toContain("data-testid=\"marketplace-actions-trigger\"");

    expect(pluginDetail).toContain("plugin.version");
    expect(pluginDetail).toContain("marketplaces.map((marketplace) => marketplace.name)");
    expect(pluginDetail).toContain("getPluginsRoute(orgSlug)");
    expect(pluginDetail).toContain("data-testid=\"plugin-actions-trigger\"");
  });

  test("cloud readiness stays silent when nothing needs a human", () => {
    const source = readDashboardComponent("marketplace-detail-screen.tsx");

    // Every plugin on Den is cloud ready, so the badge must not announce it.
    expect(source).toContain('readiness.state === "ready"');
    expect(source).toContain("return undefined");
    // The two states that need action must no longer be excluded from render.
    expect(source).not.toContain('plugin.cloudReadiness.state !== "needs_admin_setup"');
    expect(source).not.toContain('plugin.cloudReadiness.state !== "needs_signin"');
  });
});
