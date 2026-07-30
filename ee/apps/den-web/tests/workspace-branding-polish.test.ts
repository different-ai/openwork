import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const shellPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/org-dashboard-shell.tsx", import.meta.url),
);
const appearancePath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/brand-appearance-screen.tsx", import.meta.url),
);
const dashboardLayoutPath = fileURLToPath(
  new URL("../app/(den)/dashboard/layout.tsx", import.meta.url),
);

describe("workspace branding polish", () => {
  test("uses the canonical managed square icon for the workspace favicon", () => {
    const source = readFileSync(shellPath, "utf8");

    expect(source).toContain("export function WorkspaceFavicon");
    expect(source).toContain("getManagedBrandIconUrl(metadata ?? null)");
    expect(source).toContain('<WorkspaceFavicon metadata={orgContext?.organization.metadata} />');
    expect(source).toContain('DEFAULT_WORKSPACE_FAVICON_HREF = "/openwork-mark.svg"');
    expect(source).toContain("favicon.href = DEFAULT_WORKSPACE_FAVICON_HREF");
  });

  test("keeps the server-rendered favicon while the org context is loading", () => {
    const source = readFileSync(shellPath, "utf8");

    expect(source).toContain("const orgContextLoading = metadata === undefined;");
    expect(source).toContain("if (orgContextLoading) {");
    expect(source).toContain("[orgContextLoading, iconUrl]");
  });

  test("server-renders the workspace favicon from the managed square icon", () => {
    const source = readFileSync(dashboardLayoutPath, "utf8");

    expect(source).toContain("export async function generateMetadata");
    expect(source).toContain("/v1/me/orgs");
    expect(source).toContain("getManagedBrandIconUrl(activeOrg.metadata)");
    expect(source).toContain("icons: { icon: iconUrl }");
  });

  test("does not show the artificial loading line in the desktop identity preview", () => {
    const source = readFileSync(appearancePath, "utf8");

    expect(source).not.toContain("data-brand-accent");
    expect(source).not.toContain("w-2/3 rounded-full bg-violet-400");
  });
});
