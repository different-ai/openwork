import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const shellPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/org-dashboard-shell.tsx", import.meta.url),
);
const appearancePath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/brand-appearance-screen.tsx", import.meta.url),
);

describe("workspace branding polish", () => {
  test("uses the canonical managed square icon for the workspace favicon", () => {
    const source = readFileSync(shellPath, "utf8");

    expect(source).toContain("export function WorkspaceFavicon");
    expect(source).toContain("getManagedBrandIconUrl(metadata ?? null)");
    expect(source).toContain('<WorkspaceFavicon metadata={orgContext?.organization.metadata} />');
  });

  test("does not show the artificial loading line in the desktop identity preview", () => {
    const source = readFileSync(appearancePath, "utf8");

    expect(source).not.toContain("data-brand-accent");
    expect(source).not.toContain("w-2/3 rounded-full bg-violet-400");
  });
});
