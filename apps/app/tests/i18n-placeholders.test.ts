import { expect, test } from "bun:test";
import { t } from "../src/i18n";

test("every occurrence of a placeholder is filled in", () => {
  // "{name}" appears twice in this string.
  const text = t("extensions.connector_note_org_app_member", { name: "Acme", lng: "en" });
  expect(text).toBe("An admin adds your organization's Acme app in OpenWork Cloud. Then you sign in with your own Acme account.");
  expect(text).not.toContain("{name}");
});

test("placeholder values are inserted literally", () => {
  expect(t("extensions.connector_sign_in_with", { name: "$& Co", lng: "en" })).toBe("Sign in with $& Co");
});
