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
});
