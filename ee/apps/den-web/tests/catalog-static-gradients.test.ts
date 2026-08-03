import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const components = [
  "github-integration-screen.tsx",
];

const flatCatalogComponents = [
  "plugins-screen.tsx",
  "plugin-detail-screen.tsx",
  "marketplaces-screen.tsx",
  "marketplace-detail-screen.tsx",
];

const staticGradientPath = fileURLToPath(
  new URL("../../../../packages/ui/src/react/paper/static-seeded-gradient.tsx", import.meta.url),
);

describe("catalog list gradient surfaces", () => {
  test.each(components)("%s uses CSS-only seeded gradients for repeated cards", (component) => {
    const path = fileURLToPath(
      new URL(`../app/(den)/dashboard/_components/${component}`, import.meta.url),
    );
    const source = readFileSync(path, "utf8");

    expect(source).toContain("StaticSeededGradient");
  });

  test("high-cardinality list screens do not instantiate Paper shaders", () => {
    for (const component of components) {
      const path = fileURLToPath(
        new URL(`../app/(den)/dashboard/_components/${component}`, import.meta.url),
      );
      const source = readFileSync(path, "utf8");

      expect(source).not.toContain("PaperMeshGradient");
    }
  });

  test.each(flatCatalogComponents)("%s uses the shared catalog identity tile", (component) => {
    const path = fileURLToPath(
      new URL(`../app/(den)/dashboard/_components/${component}`, import.meta.url),
    );
    const source = readFileSync(path, "utf8");

    expect(source).toContain("CatalogIdentityTile");
    expect(source).not.toContain("StaticSeededGradient");
    expect(source).not.toContain("PaperMeshGradient");
  });

  test("CSS-only surfaces expose a stable runtime proof marker", () => {
    const source = readFileSync(staticGradientPath, "utf8");

    expect(source).toContain('data-static-paper-gradient=""');
  });
});
