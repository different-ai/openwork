import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const screenPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/org-settings-screen.tsx", import.meta.url),
);
const sectionPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/organization-settings-section.tsx", import.meta.url),
);

describe("organization desktop version settings", () => {
  test("renders generated versions newest-first in a bounded scrolling list", () => {
    const screen = readFileSync(screenPath, "utf8");
    const section = readFileSync(sectionPath, "utf8");

    expect(screen).toContain("metadata.publishedDesktopVersions");
    expect(section).toContain('data-testid="desktop-version-list"');
    expect(section).toContain("max-h-[400px]");
    expect(section).toContain("overflow-y-auto");
  });

  test("disables versions newer than the server maximum with guidance", () => {
    const source = readFileSync(sectionPath, "utf8");

    expect(source).toContain("requiresServerUpgrade");
    expect(source).toContain("disabled={!canManageDesktopVersions || requiresServerUpgrade}");
    expect(source).toContain("Upgrade server to allow this version");
  });

  test("keeps workspace admins read-only for desktop version settings", () => {
    const screen = readFileSync(screenPath, "utf8");
    const section = readFileSync(sectionPath, "utf8");

    expect(screen).toContain("const canManageDesktopVersions = access.canManageSettings");
    expect(section).toContain("Admins can view settings here. Owners and super-admins can change them.");
    expect(section).toContain("disabled={!canManageSettings}");
  });
});
