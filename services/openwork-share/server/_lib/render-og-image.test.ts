import test from "node:test";
import assert from "node:assert/strict";

import { buildBundleOgImageModel, renderBundleOgImage, renderRootOgImage } from "./render-og-image.ts";

test("renderRootOgImage uses the simplified metadata-first card", () => {
  const svg = renderRootOgImage();

  assert.match(svg, /Share OpenWork skills/);
  assert.match(svg, />beautifully</);
  assert.match(svg, /#257CE9/);
  assert.doesNotMatch(svg, /agent-creator\.md/);
  assert.match(svg, /openwork preview/);
  assert.doesNotMatch(svg, /Before we start, use the question tool/);
});

test("renderBundleOgImage focuses on bundle metadata instead of bundle body text", () => {
  const rawJson = JSON.stringify({
    schemaVersion: 1,
    type: "skill",
    name: "follow-up-reminder",
    description: "Shareable reminder skill",
    trigger: "idle",
    content: "# follow-up-reminder\n\n## Trigger\n\nRuns after the conversation is idle for 24h."
  });

  const svg = renderBundleOgImage({ id: "01TESTPREVIEW", rawJson });
  const model = buildBundleOgImageModel({ id: "01TESTPREVIEW", rawJson });

  assert.equal(model.title, "Follow Up Reminder");
  assert.equal(model.fileName, "follow-up-reminder.md");
  assert.equal(model.tag, "trigger: idle");
  assert.match(svg, /Follow Up Reminder/);
  assert.doesNotMatch(svg, /follow-up-reminder\.md/);
  assert.match(svg, /trigger: idle/);
  assert.doesNotMatch(svg, /Runs after the conversation is idle for 24h/);
});

test("renderBundleOgImage supports platform-specific canvas dimensions", () => {
  const rawJson = JSON.stringify({
    schemaVersion: 1,
    type: "skill",
    name: "follow-up-reminder",
    description: "Shareable reminder skill",
    content: "# follow-up-reminder",
  });

  const twitterSvg = renderBundleOgImage({ id: "01TESTPREVIEW", rawJson, variant: "twitter" });
  const linkedinSvg = renderBundleOgImage({ id: "01TESTPREVIEW", rawJson, variant: "linkedin" });

  assert.match(twitterSvg, /<svg width="1200" height="600"/);
  assert.match(linkedinSvg, /<svg width="1200" height="627"/);
});
