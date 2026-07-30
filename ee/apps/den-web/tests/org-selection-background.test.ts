import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const orgSelectionPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/org-selection-screen.tsx", import.meta.url),
);

function readOrgSelectionSource() {
  return readFileSync(orgSelectionPath, "utf8");
}

describe("org selection desktop sign-in pattern", () => {
  test("uses the same dither + centered card shell as desktop forced sign-in", () => {
    const source = readOrgSelectionSource();

    expect(source).toContain('data-testid="org-chooser-root"');
    expect(source).toContain('data-testid="org-chooser-background"');
    expect(source).toContain('opacity-[0.1]');
    expect(source).toContain('type="2x2"');
    expect(source).toContain("size={20.3}");
    expect(source).toContain('colorBack="#00000000"');
    expect(source).toContain('colorFront="#000000"');
    expect(source).toContain("const shaderSpeed = reducedMotion ? 0 : 0.01;");
    expect(source).toContain("max-w-[720px]");
    expect(source).toContain("rounded-3xl");
    expect(source).toContain("/openwork-mark.svg");
    expect(source).not.toContain("bg-[#f8fbff]");
    expect(source).not.toContain('colorFront="#8FB7E8"');
    expect(source).not.toContain("PaperMeshGradient");
  });

  test("keeps the organization list readable and interactive", () => {
    const source = readOrgSelectionSource();

    expect(source).toContain('data-testid="org-chooser-foreground"');
    expect(source).toContain('data-testid="org-chooser-list"');
    expect(source).toContain("Choose an organization");
    expect(source).toContain("hover:bg-[var(--dls-hover)]");
  });

  test("keeps the shell and actions stable on small screens", () => {
    const source = readOrgSelectionSource();

    expect(source).toContain('data-testid="org-chooser-actions"');
    expect(source).toContain("Create or join");
    expect(source).toContain("Sign out");
    expect(source).toContain("sm:px-16");
  });
});
