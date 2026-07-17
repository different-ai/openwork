import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const orgSelectionPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/org-selection-screen.tsx", import.meta.url),
);

function readOrgSelectionSource() {
  return readFileSync(orgSelectionPath, "utf8");
}

describe("org selection paper contract", () => {
  test("uses the same light Dithering layer as the join flow", () => {
    const source = readOrgSelectionSource();

    expect(source).toContain('className="relative isolate min-h-dvh overflow-y-auto bg-[#f8fbff] px-4 py-8 text-slate-950 sm:py-12"');
    expect(source).toContain('className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-[#f8fbff] opacity-[0.09]"');
    expect(source).toContain('colorBack="#F8FBFF"');
    expect(source).toContain('colorFront="#8FB7E8"');
    expect(source).toContain("const shaderSpeed = reducedMotion ? 0 : 0.012;");
    expect(source).toContain('data-shader-speed={shaderSpeed}');
    expect(source).toContain('className="den-frame-inset grid gap-2 rounded-[1.5rem] p-2"');
    expect(source).not.toContain("bg-[#0f1d31]");
    expect(source).not.toContain("PaperMeshGradient");
  });

  test("keeps the organization list readable and interactive", () => {
    const source = readOrgSelectionSource();

    expect(source).toContain('data-testid="org-chooser-foreground"');
    expect(source).toContain('data-testid="org-chooser-list"');
    expect(source).toContain("hover:bg-white");
    expect(source).not.toContain("disabled:opacity");
  });

  test("keeps the shell and actions stable on small screens", () => {
    const source = readOrgSelectionSource();

    expect(source).toContain('data-testid="org-chooser-root"');
    expect(source).toContain('data-testid="org-chooser-actions"');
    expect(source).toContain("Create or join");
    expect(source).toContain("Sign out");
  });
});
