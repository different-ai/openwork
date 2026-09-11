import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the compact sidebar mark changes only the source mark's viewBox", () => {
  const guidance = "Sync the sidebar artwork with openwork-mark.svg and regenerate the compact viewBox after a rebrand";
  const artwork = ["openwork-mark.svg", "openwork-sidebar-mark.svg"].map(name => {
    const source = readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8")
      .match(/<svg\b[\s\S]*<\/svg>\s*$/)?.[0];
    if (!source) throw new Error(`${name}: SVG root required; ${guidance}`);
    const viewBox = /\sviewBox\s*=\s*(["'])[\s\S]*?\1/g;
    expect([...source.matchAll(viewBox)], `${name}: exactly one viewBox required; ${guidance}`).toHaveLength(1);
    const paths = [...source.matchAll(/<path\b[^>]*>/g)];
    expect(paths.length, `${name}: paths must be present; ${guidance}`).toBeGreaterThan(0);
    for (const [path] of paths) {
      expect(path, guidance).toMatch(/\sd\s*=\s*(["']).+?\1/s);
      expect(path, guidance).toMatch(/\sfill\s*=\s*(["']).+?\1/s);
    }
    // Preserve attribute bytes and all other markup, including transforms and groups.
    return source.replace(viewBox, "").trim();
  });
  expect(artwork[1], guidance).toBe(artwork[0]);
});
