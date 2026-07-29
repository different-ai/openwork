import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  getPanelDestinations,
  handlePanelEscape,
  PanelEmpty,
} from "../src/react-app/domains/session/panel/panel-empty";

describe("right panel empty state", () => {
  test("renders spacious keyboard-accessible destination actions", () => {
    const html = renderToStaticMarkup(
      <PanelEmpty
        onOpenBrowser={() => undefined}
        onOpenExtensions={() => undefined}
        onOpenVoice={() => undefined}
      />,
    );

    expect(html).toContain("Choose a destination");
    expect(html).toContain("Browser");
    expect(html).toContain("Files &amp; artifacts");
    expect(html).toContain("Extensions");
    expect(html).toContain("Voice Mode");
    expect(html).toContain('aria-label="Panel destinations"');
    expect(html.match(/<button/g)).toHaveLength(4);
    expect(html).toContain("min-h-16");
    expect(html).toContain("w-full");
    expect(html).toContain("overflow-y-auto");
  });

  test("shows only destinations supported by the runtime", () => {
    const html = renderToStaticMarkup(<PanelEmpty />);

    expect(html).toContain("Files &amp; artifacts");
    expect(html).not.toContain("Browser");
    expect(html).not.toContain("Extensions");
    expect(html).not.toContain("Voice Mode");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  test("activates every available destination through its supplied handler", () => {
    const activated: string[] = [];
    const destinations = getPanelDestinations(
      {
        onOpenBrowser: () => activated.push("browser"),
        onOpenExtensions: () => activated.push("extensions"),
        onOpenVoice: () => activated.push("voice"),
      },
      () => activated.push("files"),
    );

    for (const destination of destinations) destination.activate();

    expect(activated).toEqual(["browser", "files", "extensions", "voice"]);
  });

  test("closes on Escape without consuming unrelated keys", () => {
    let closeCount = 0;

    expect(handlePanelEscape("ArrowDown", () => { closeCount += 1; })).toBe(false);
    expect(handlePanelEscape("Escape", () => { closeCount += 1; })).toBe(true);
    expect(closeCount).toBe(1);
  });
});
