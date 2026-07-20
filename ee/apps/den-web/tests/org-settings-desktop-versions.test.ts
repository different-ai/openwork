import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const settingsPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/org-settings-screen.tsx", import.meta.url),
);

describe("organization desktop version settings", () => {
  test("renders generated versions newest-first in a bounded scrolling list", () => {
    const source = readFileSync(settingsPath, "utf8");

    expect(source).toContain("metadata.publishedDesktopVersions");
    expect(source).toContain('data-testid="desktop-version-list"');
    expect(source).toContain("max-h-[400px]");
    expect(source).toContain("overflow-y-auto");
  });

  test("disables versions newer than the server maximum with guidance", () => {
    const source = readFileSync(settingsPath, "utf8");

    expect(source).toContain("requiresServerUpgrade");
    expect(source).toContain("disabled={!isOwner || requiresServerUpgrade}");
    expect(source).toContain("Upgrade server to allow this version");
  });
});
