import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import { getInitialIsMobile } from "../src/hooks/use-mobile";

const settingsShellPath = fileURLToPath(
  new URL("../src/react-app/domains/settings/shell/settings-shell.tsx", import.meta.url),
);

// Tailwind v4 default breakpoints. The Settings sidebar becomes an off-canvas
// sheet whenever `useIsMobile()` is true, so the header controls that reopen
// it (sidebar trigger) or leave Settings (close button) must stay visible for
// exactly that same range of widths. If the two ever disagree, windows in the
// gap have no visible way back to the app.
const TAILWIND_LG_MIN_WIDTH = 1024;

function mobileBreakpointFromMediaQuery() {
  let query = "";
  getInitialIsMobile((received) => {
    query = received;
    return { matches: false };
  });
  const match = /\(max-width: (\d+)px\)/.exec(query);
  if (!match) throw new Error(`unexpected mobile media query: ${query}`);
  return Number(match[1]) + 1;
}

describe("Settings shell in a narrow window", () => {
  const source = readFileSync(settingsShellPath, "utf8");
  const desktopShell = source.slice(source.indexOf("<SidebarProvider"));

  test("the sidebar's mobile breakpoint is Tailwind's lg breakpoint", () => {
    expect(mobileBreakpointFromMediaQuery()).toBe(TAILWIND_LG_MIN_WIDTH);
  });

  test("the sidebar trigger stays visible until the inline sidebar takes over", () => {
    expect(desktopShell).toMatch(/<SidebarTrigger className="[^"]*\blg:hidden\b/);
    expect(desktopShell).not.toMatch(/<SidebarTrigger className="[^"]*\bmd:hidden\b/);
  });

  test("the close button stays visible until the sidebar's Back to app takes over", () => {
    const closeButton = desktopShell.slice(
      desktopShell.indexOf("<NotificationBell />"),
      desktopShell.indexOf("</header>"),
    );
    expect(closeButton).toContain("onClick={props.onClose}");
    expect(closeButton).toMatch(/className="[^"]*\blg:hidden\b/);
    expect(closeButton).not.toMatch(/\bmd:hidden\b/);
  });

  test("the header clears the macOS traffic lights while the sidebar is off-canvas", () => {
    expect(desktopShell).toContain("[&_header]:pl-16 lg:[&_header]:pl-6");
    expect(desktopShell).not.toContain("md:[&_header]:pl-6");
  });
});
