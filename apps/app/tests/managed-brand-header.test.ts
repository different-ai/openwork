import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const sidebarPath = fileURLToPath(
  new URL("../src/react-app/domains/session/sidebar/app-sidebar.tsx", import.meta.url),
);

describe("managed brand header", () => {
  test("shows the brand header only when a wordmark is supplied", () => {
    const source = readFileSync(sidebarPath, "utf8");

    expect(source).toMatch(/\{brandLogoUrl \? \([\s\S]*?data-testid="brand-logo"[\s\S]*?<img/);
    expect(source).not.toContain("brand-app-name");
    expect(source).not.toContain("useBrandAppName");
    expect(source).toMatch(/className="flex h-14 shrink-0 items-center/);
    expect(source).toMatch(/className="max-h-9 w-auto max-w-\[140px\] object-contain object-left"/);
  });
});
