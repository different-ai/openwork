import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Puzzle } from "lucide-react";

import { SidebarProvider, SidebarMenu } from "../src/components/ui/sidebar";
import { SidebarDestination } from "../src/react-app/domains/session/sidebar/sidebar-destination";
import { SettingsPageHeading } from "../src/react-app/domains/settings/shell/settings-page";

describe("Extensions sidebar destination", () => {
  test("exposes its label, keyboard button, and active page state", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarMenu>
          <SidebarDestination
            active
            icon={Puzzle}
            label="Extensions"
            onSelect={() => {}}
          />
        </SidebarMenu>
      </SidebarProvider>,
    );

    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Extensions"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("data-active");
    expect(html).toContain(">Extensions<");
  });
});

describe("Extensions page header", () => {
  test("renders one correctly named page heading", () => {
    const html = renderToStaticMarkup(<SettingsPageHeading activeTab="extensions" />);

    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain(">Extensions</h1>");
    expect(html).not.toContain("<h2");
  });
});
