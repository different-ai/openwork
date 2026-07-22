import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const components = [
  "plugins-screen.tsx",
  "marketplaces-screen.tsx",
  "marketplace-detail-screen.tsx",
  "github-integration-screen.tsx",
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
    const listComponents = components.filter((component) => component !== "marketplace-detail-screen.tsx");

    for (const component of listComponents) {
      const path = fileURLToPath(
        new URL(`../app/(den)/dashboard/_components/${component}`, import.meta.url),
      );
      const source = readFileSync(path, "utf8");

      expect(source).not.toContain("PaperMeshGradient");
    }
  });

  test("marketplace detail retains one bounded hero shader", () => {
    const path = fileURLToPath(
      new URL("../app/(den)/dashboard/_components/marketplace-detail-screen.tsx", import.meta.url),
    );
    const source = readFileSync(path, "utf8");
    const shaderInstances = source.match(/<PaperMeshGradient/g) ?? [];

    expect(shaderInstances).toHaveLength(1);
  });

  test("CSS-only surfaces expose a stable runtime proof marker", () => {
    const source = readFileSync(staticGradientPath, "utf8");

    expect(source).toContain('data-static-paper-gradient=""');
  });
});
