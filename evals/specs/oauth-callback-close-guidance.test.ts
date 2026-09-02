import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { connectCallbackPage } from "../../ee/apps/den-api/src/capability-sources/oauth-callback-page";

test("OAuth completion gives usable guidance when a system browser refuses to close its tab", async ({ evidence }) => {
  const html = connectCallbackPage({ ok: true, name: "Notion" });

  expect(html).toContain('id="close-window-button"');
  expect(html).toContain("window.close();");
  expect(html).toContain("window.setTimeout");
  expect(html).toContain("closeButton.hidden = true");
  expect(html).toContain("manualCloseGuidance.hidden = false");
  expect(html).toContain("Your browser prevented OpenWork from closing this tab automatically.");
  expect(html).toContain("Close this tab to return to OpenWork.");
  expect(html).not.toContain('onclick="window.close()"');

  evidence.recordAssertionEvidence(
    "OAuth completion handles browser-enforced tab closing restrictions",
    "The completion page first asks the browser to close, then replaces the ineffective control with accessible manual-close guidance if the externally opened tab remains visible.",
    true,
  );
});
