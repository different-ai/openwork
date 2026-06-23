import { describe, expect, test } from "bun:test";

import tailwindConfig from "../tailwind.config";
import { THEME_PREVIEW_CLASSES } from "../src/react-app/domains/settings/appearance/theme-section";

describe("theme picker previews", () => {
  test("uses fixed light and dark preview colors", () => {
    expect(THEME_PREVIEW_CLASSES.light).toBe("bg-white");
    expect(THEME_PREVIEW_CLASSES.dark).toBe("bg-black");
  });

  test("uses colors defined by the Tailwind palette", () => {
    for (const className of Object.values(THEME_PREVIEW_CLASSES)) {
      const colorName = className.replace("bg-", "");

      expect(Object.hasOwn(tailwindConfig.theme.colors, colorName)).toBe(true);
    }
  });
});
