import { describe, expect, test } from "bun:test";

import { PERSON_BROWSER_WIDTH, personBrowserPanelWidth } from "../src/react-app/domains/session/panel/browser-panel-width";

describe("personBrowserPanelWidth", () => {
  test("widens a narrow panel so a clicked page is readable", () => {
    expect(personBrowserPanelWidth(320, 1700)).toBe(PERSON_BROWSER_WIDTH);
  });

  test("leaves the chat over half the room on a smaller window", () => {
    expect(personBrowserPanelWidth(320, 1100)).toBe(605);
  });

  test("keeps a width the person already made wider", () => {
    expect(personBrowserPanelWidth(1000, 1700)).toBe(1000);
  });
});
