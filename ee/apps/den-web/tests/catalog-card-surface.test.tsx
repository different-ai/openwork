import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import {
  CatalogColorRail,
  catalogCardSwatches,
  getCatalogCardSwatch,
} from "../app/(den)/dashboard/_components/catalog-card-surface";

function readDashboardComponent(name: string) {
  return readFileSync(
    fileURLToPath(new URL(`../app/(den)/dashboard/_components/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("Den catalog card colors", () => {
  test("selects a deterministic workspace swatch from the stable item id", () => {
    const first = getCatalogCardSwatch("plugin-stable-id", "Unmapped plugin");
    const second = getCatalogCardSwatch("plugin-stable-id", "Unmapped plugin");

    expect(second).toBe(first);
    expect(catalogCardSwatches).toContain(first);

    const varied = new Set(
      Array.from({ length: 24 }, (_, index) =>
        getCatalogCardSwatch(`plugin-${index}`, `Plugin ${index}`),
      ),
    );
    expect(varied.size).toBeGreaterThan(1);
  });

  test("keeps the named reference assignments", () => {
    expect(getCatalogCardSwatch("posthog-id", "PostHog Attribution & WAU")).toBe("#2563eb");
    expect(getCatalogCardSwatch("posthog-id", "PostHog Plugin")).toBe("#2563eb");
    expect(getCatalogCardSwatch("ben-id", "Ben Private Marketplace")).toBe("#5a67d8");
    expect(getCatalogCardSwatch("plan-id", "Plan My Day")).toBe("#5a67d8");
    expect(getCatalogCardSwatch("review-id", "Review Missed Messages")).toBe("#f97316");
  });

  test("renders the same flat rail in directory and detail contexts without an identity icon", () => {
    const directory = renderToStaticMarkup(
      createElement(CatalogColorRail, {
        itemId: "shared-plugin-id",
        itemName: "Shared plugin",
        size: "card",
      }),
    );
    const detail = renderToStaticMarkup(
      createElement(CatalogColorRail, {
        itemId: "shared-plugin-id",
        itemName: "Shared plugin",
        size: "detail",
      }),
    );
    const swatch = getCatalogCardSwatch("shared-plugin-id", "Shared plugin");

    expect(directory).toContain(`data-catalog-card-swatch="${swatch}"`);
    expect(detail).toContain(`data-catalog-card-swatch="${swatch}"`);
    expect(directory).not.toContain("<svg");
    expect(detail).not.toContain("<svg");
    expect(directory).not.toContain("<img");
    expect(detail).not.toContain("<img");
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
    expect(marketplaceDetail).toContain("cloudReadinessLabel(plugin.cloudReadiness.state)");
    expect(marketplaceDetail).toContain('return "Cloud ready"');
    expect(marketplaceDetail).toContain("data-testid=\"marketplace-actions-trigger\"");

    expect(pluginDetail).toContain("plugin.version");
    expect(pluginDetail).toContain("plugin.marketplaces");
    expect(pluginDetail).toContain("getPluginsRoute(orgSlug)");
    expect(pluginDetail).toContain("data-testid=\"plugin-actions-trigger\"");
  });
});
