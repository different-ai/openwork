import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const settingsPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/brand-appearance-screen.tsx", import.meta.url),
);
const generalSettingsPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/org-settings-screen.tsx", import.meta.url),
);

describe("organization branding layout", () => {
  test("contains long selected-image status text inside the responsive grid", () => {
    const source = readFileSync(settingsPath, "utf8");

    expect(source).toMatch(/<form className="grid gap-6"/);
    expect(source).toMatch(/className="grid min-w-0 gap-5 lg:grid-cols-2"/);
    expect(source).toMatch(/className="grid min-w-0 gap-3 rounded-2xl/);
    expect(source).toMatch(/className="min-h-9 min-w-0 break-words/);
    expect(source).toContain('data-testid="brand-appearance-screen"');
  });

  test("keeps branding state and writes out of General settings", () => {
    const brandSource = readFileSync(settingsPath, "utf8");
    const generalSource = readFileSync(generalSettingsPath, "utf8");

    expect(brandSource).toContain('brandAppName: appNameDraft.trim() || null');
    expect(brandSource).toContain('brandAccentColor: accentColorDraft || null');
    expect(generalSource).not.toContain("brandAppName");
    expect(generalSource).not.toContain("brandAccentColor");
  });
});
