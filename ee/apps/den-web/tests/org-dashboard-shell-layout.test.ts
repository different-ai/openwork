import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const shellPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/org-dashboard-shell.tsx", import.meta.url),
);

describe("OrgDashboardShell layout", () => {
  test("bounds the desktop shell to the viewport while dashboard content scrolls", () => {
    const source = readFileSync(shellPath, "utf8");

    expect(source).toMatch(/<div className="[^\"]*\bmd:h-screen\b[^\"]*\bmd:flex-row\b[^\"]*">/);
    expect(source).toMatch(/<main className="[^\"]*\bflex-1\b[^\"]*\boverflow-y-auto\b[^\"]*">/);
  });

  test("pins the workspace switcher and scrolls only the nav when Settings expands", () => {
    const source = readFileSync(shellPath, "utf8");

    expect(source).toMatch(/<aside className="[^\"]*\boverflow-hidden\b[^\"]*\bmd:h-screen\b[^\"]*">/);
    expect(source).toMatch(/<nav className="[^\"]*\bmin-h-0\b[^\"]*\boverflow-x-hidden\b[^\"]*\boverflow-y-auto\b[^\"]*" data-testid="den-org-sidebar">/);
    expect(source).toContain('data-testid="den-org-sidebar-footer"');
    expect(source).toMatch(/className="[^\"]*\bmt-auto\b[^\"]*\bshrink-0\b[^\"]*" data-testid="den-org-sidebar-footer"/);
    expect(source).not.toMatch(/<aside className="[^\"]*\bmd:min-h-screen\b[^\"]*">/);
  });

  test("bounds the workspace switcher and dismisses only outside pointer input", () => {
    const source = readFileSync(shellPath, "utf8");

    expect(source).toContain("grid-cols-[minmax(0,1fr)]");
    expect(source).toContain("max-w-[calc(100vw-1.5rem)]");
    expect(source).toContain('document.addEventListener("pointerdown", handlePointerDown)');
    expect(source).toContain('data-workspace-switcher-root=""');
    expect(source).toContain("event.composedPath().some(");
    expect(source).toContain('target.hasAttribute("data-workspace-switcher-root")');
    expect(source).toContain("if (!clickedInsideSwitcher)");
  });

  test("links Docs to the public documentation site", () => {
    const source = readFileSync(shellPath, "utf8");

    expect(source).toContain('const OPENWORK_DOCS_URL = "https://openworklabs.com/docs";');
  });
});
