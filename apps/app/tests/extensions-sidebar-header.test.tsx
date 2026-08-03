import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Puzzle } from "lucide-react";

import { SidebarProvider, SidebarMenu } from "../src/components/ui/sidebar";
import { SidebarDestination } from "../src/react-app/domains/session/sidebar/sidebar-destination";
import { getWorkspaceSettingsTabs } from "../src/react-app/domains/settings/shell/settings-page";

const appSidebarPath = fileURLToPath(
  new URL("../src/react-app/domains/session/sidebar/app-sidebar.tsx", import.meta.url),
);
const sessionPagePath = fileURLToPath(
  new URL("../src/react-app/domains/session/chat/session-page.tsx", import.meta.url),
);


describe("Extensions sidebar destination", () => {
  test("exposes its label, keyboard button, and active page state", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarMenu>
          <SidebarDestination
            active
            icon={Puzzle}
            label="Library"
            onSelect={() => {}}
          />
        </SidebarMenu>
      </SidebarProvider>,
    );

    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Library"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("data-active");
    expect(html).toContain(">Library<");
    // Idle weight matches the neighboring Search row (70% foreground) so the
    // sidebar header reads as one family; active/hover restore full strength.
    expect(html).toContain("text-sidebar-foreground/70");
  });

  test("sits below Search and above Pinned sessions", () => {
    const source = readFileSync(appSidebarPath, "utf8");
    const searchIndex = source.indexOf("<Search");
    const extensionsIndex = source.indexOf("<SidebarDestination");
    const pinnedIndex = source.indexOf("{pinnedSessions.length");
    const footerIndex = source.indexOf("<SidebarFooter");

    expect(searchIndex).toBeGreaterThan(-1);
    expect(extensionsIndex).toBeGreaterThan(searchIndex);
    expect(pinnedIndex).toBeGreaterThan(extensionsIndex);
    expect(footerIndex).toBeGreaterThan(extensionsIndex);
    expect(source.slice(footerIndex)).not.toContain("<SidebarDestination");
  });
});

describe("Extensions main page", () => {
  test("uses the main content header and is listed in Settings navigation", () => {
    const sessionPageSource = readFileSync(sessionPagePath, "utf8");

    expect(sessionPageSource).toContain("props.mainContentTitle");
    expect(sessionPageSource).toContain("<h1");
    // The Library is intentionally reachable both standalone and inside the
    // Settings pane (feat: Library inside the Settings pane).
    expect(getWorkspaceSettingsTabs()).toContain("extensions");
  });
});
