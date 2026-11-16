/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArchivedComposerFeedback } from "../src/react-app/domains/session/surface/archived-composer-feedback";
import { ArchivedComposerRestoreError, archivedComposerRestoreErrorMessage } from "../src/react-app/domains/session/surface/archived-composer-send";
import { currentLocale, LANGUAGES, setLocale, t } from "../src/i18n";

const initialLocale = currentLocale();
afterEach(() => setLocale(initialLocale));

describe("archived composer feedback", () => {
  test("hint and inline failure share the composer's centered 800px column and responsive gutters", () => {
    const markup = renderToStaticMarkup(<ArchivedComposerFeedback archived error="Saved draft" />);
    expect(markup).toStartWith('<div class="px-4 max-lg:px-3 lg:px-8"><div class="max-w-[800px] mx-auto">');
    expect(markup).toContain('data-testid="archived-composer-hint"');
    expect(markup).toContain('<p role="alert" class="mb-2 text-xs text-destructive">Saved draft</p>');
    expect(markup).not.toContain("mx-3");
  });

  test("an inline restore failure remains visible after archive metadata updates", () => {
    const markup = renderToStaticMarkup(<ArchivedComposerFeedback archived={false} error="Saved draft" />);
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain("archived-composer-hint");
    expect(renderToStaticMarkup(<ArchivedComposerFeedback archived={false} error={null} />)).toBe("");
  });

  test("hint, send/preparing label and all safe reasons resolve through locale-to-English fallback", () => {
    for (const locale of LANGUAGES) {
      setLocale(locale);
      const hint = t("session_management.archived_compose_hint");
      const sendLabel = t("session_management.archived_compose_send");
      expect(hint).toBe("Sending a message will unarchive this conversation.");
      expect(sendLabel).toBe("Send & unarchive");
      expect(renderToStaticMarkup(<ArchivedComposerFeedback archived error={null} />)).toContain(hint);
      for (const error of [
        new ArchivedComposerRestoreError("timeout"),
        new ArchivedComposerRestoreError("verification_failed"),
        new ArchivedComposerRestoreError("unarchive_failed"),
      ]) {
        const message = archivedComposerRestoreErrorMessage(error);
        expect(message).toBe(t(`session_management.archived_compose_${error.code}`));
        expect(message).toContain("Your draft is saved.");
        expect(message).not.toContain("session_management.");
      }
    }
  });
});
