import { describe, expect, test } from "bun:test";

import {
  MODEL_PICKER_DEFAULT_SUBTITLE,
  MODEL_PICKER_UNAVAILABLE_SUBTITLE,
  resolveModelPickerSubtitle,
} from "../src/react-app/domains/session/modals/model-picker-modal";
import { setLocale } from "../src/i18n";

describe("model picker subtitle", () => {
  test("keeps the normal session subtitle by default", () => {
    setLocale("en");
    expect(resolveModelPickerSubtitle(undefined)).toBe(MODEL_PICKER_DEFAULT_SUBTITLE);
  });

  test("supports the unavailable-model recovery subtitle", () => {
    setLocale("en");
    expect(resolveModelPickerSubtitle(MODEL_PICKER_UNAVAILABLE_SUBTITLE)).toBe(
      "The model you were using is no longer available. Select a different model for this session.",
    );
  });

  test("localizes the known session subtitles", () => {
    setLocale("de");
    expect(resolveModelPickerSubtitle(undefined)).toBe("Modell für diese Session auswählen.");
    expect(resolveModelPickerSubtitle(MODEL_PICKER_UNAVAILABLE_SUBTITLE)).toContain("nicht mehr verfügbar");
    setLocale("en");
  });
});
