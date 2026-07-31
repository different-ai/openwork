import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import { DashboardPageMaturityBadge } from "../app/(den)/_components/ui/dashboard-page-template";

function readDashboardComponent(name: string) {
  return readFileSync(
    fileURLToPath(new URL(`../app/(den)/dashboard/_components/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("Sources Alpha maturity", () => {
  test("labels the Sources navigation and page hero as Alpha", () => {
    const shell = readDashboardComponent("org-dashboard-shell.tsx");
    const screen = readDashboardComponent("integrations-screen.tsx");

    expect(shell).toContain('label: "Sources", badge: "Alpha"');
    expect(shell).toContain('return "Sources";');
    expect(screen).toContain('title="Sources"');
    expect(screen).toContain('badgeLabel="Alpha"');
    expect(screen).not.toContain('badgeLabel="Preview"');
  });

  test("gives the shared page maturity badge an explicit accessible name", () => {
    const markup = renderToStaticMarkup(
      <DashboardPageMaturityBadge label="Alpha" title="Sources" />,
    );

    expect(markup).toContain('aria-label="Sources maturity: Alpha"');
    expect(markup).toContain(">Alpha</span>");
  });

  test("gives sidebar maturity badges explicit accessible names", () => {
    const shell = readDashboardComponent("org-dashboard-shell.tsx");

    expect(shell).toContain('aria-label={`${child.label} maturity: ${child.badge}`}');
    expect(shell).toContain('aria-label={`${item.label} maturity: ${item.badge}`}');
  });
});
