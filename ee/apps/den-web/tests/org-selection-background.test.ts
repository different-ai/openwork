import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const orgSelectionPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/org-selection-screen.tsx", import.meta.url),
);

function readOrgSelectionSource() {
  return readFileSync(orgSelectionPath, "utf8");
}

describe("org selection background contract", () => {
  test("uses one scoped Dithering layer and no Paper mesh", () => {
    const source = readOrgSelectionSource();
    const ditheringImports = source.match(/import \{ Dithering \} from "@paper-design\/shaders-react"/g) ?? [];
    const ditheringUses = source.match(/<Dithering\b/g) ?? [];

    expect(ditheringImports).toHaveLength(1);
    expect(ditheringUses).toHaveLength(1);
    expect(source).not.toContain("PaperMeshGradient");
    expect(source).toContain('data-testid="org-chooser-background"');
    expect(source).toContain('aria-hidden="true"');
  });

  test("keeps the shader decorative, low-opacity, and behind readable content", () => {
    const source = readOrgSelectionSource();

    expect(source).toContain("pointer-events-none fixed inset-0 z-0");
    expect(source).toContain("opacity-[0.10]");
    expect(source).not.toContain("-z-10");
    expect(source).toContain('data-testid="org-chooser-foreground"');
    expect(source).toContain("relative z-10");
    expect(source).toMatch(/className="[^"]*\bbg-white\b[^"]*" data-testid="org-chooser-list"/);
    expect(source).not.toContain("disabled:opacity");
  });

  test("runs almost still unless reduced motion is requested", () => {
    const source = readOrgSelectionSource();

    expect(source).toContain("useSyncExternalStore");
    expect(source).toContain('const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";');
    expect(source).toContain("function getReducedMotionServerSnapshot()");
    expect(source).toContain('mediaQuery.addEventListener("change", onStoreChange)');
    expect(source).toContain('mediaQuery.removeEventListener("change", onStoreChange)');
    expect(source).toContain("const shaderSpeed = reducedMotion ? 0 : 0.012;");
    expect(source).toContain("speed={shaderSpeed}");
  });

  test("keeps the shell scroll-safe and actions stable on small screens", () => {
    const source = readOrgSelectionSource();

    expect(source).toContain("min-h-dvh overflow-y-auto bg-[#0f1d31]");
    expect(source).toContain("min-h-[calc(100dvh-4rem)]");
    expect(source).toContain('data-testid="org-chooser-root"');
    expect(source).toContain('data-testid="org-chooser-actions"');
    expect(source).toContain("Create or join");
    expect(source).toContain("Sign out");
  });
});
