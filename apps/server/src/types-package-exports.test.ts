import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The packaged builds bundle this app's OpenCode plugins with `--target node`,
 * so every workspace import resolves through the exporting package's own
 * conditions. A subpath that points at `dist/` only resolves after that package
 * has been built, which the Docker and alpha pipelines do not guarantee — and
 * neither typechecks nor bun tests take that route, so nothing catches it
 * before merge. Keep every subpath resolvable from source.
 */
describe("@openwork/types package exports", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../../packages/types/package.json"), "utf8"),
  ) as { exports: Record<string, Record<string, string> | string> };

  test("every subpath resolves from source under every condition", () => {
    const buildDependent = Object.entries(manifest.exports).flatMap(([subpath, target]) => {
      const conditions = typeof target === "string" ? { default: target } : target;
      const offending = Object.entries(conditions)
        .filter(([, value]) => typeof value === "string" && value.includes("/dist/"))
        .map(([condition]) => condition);
      return offending.length > 0 ? [`${subpath} (${offending.join(", ")})`] : [];
    });

    expect(buildDependent).toEqual([]);
  });

  test("the runtime subpaths this app imports are declared", () => {
    // Regression anchor: automations is a runtime module (zod schemas), unlike
    // the type-only subpaths that surrounded it when it was introduced.
    expect(manifest.exports["./automations"]).toMatchObject({
      types: "./src/automations.ts",
      default: "./src/automations.ts",
    });
  });
});
