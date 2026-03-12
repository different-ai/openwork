import test from "node:test";
import assert from "node:assert/strict";

import { renderBundleOgImage, renderRootOgImage } from "./render-og-image.ts";

test("renderRootOgImage uses the preview-panel inspired layout", () => {
  const svg = renderRootOgImage();

  assert.match(svg, /PREVIEW/);
  assert.match(svg, /PACKAGE CONTENTS/);
  assert.match(svg, /meeting-reminder\.md/);
});

test("renderBundleOgImage includes bundle-specific preview content", () => {
  const rawJson = JSON.stringify({
    schemaVersion: 1,
    type: "skill",
    name: "follow-up-reminder",
    description: "Shareable reminder skill",
    trigger: "idle",
    content: "# follow-up-reminder\n\n## Trigger\n\nRuns after the conversation is idle for 24h."
  });

  const svg = renderBundleOgImage({ id: "01TESTPREVIEW", rawJson });

  assert.match(svg, /follow-up-reminder/);
  assert.match(svg, /follow-up-reminder\.md/);
  assert.match(svg, /Trigger: idle/);
});
