import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PREVIEW_ITEMS,
  getPublishWarnings,
  getPreviewItems,
  getPreviewPanelState,
  getPublishedWarnings,
  getSummaryCards,
  getShareFeedback,
} from "./share-home-state.js";

test("getPreviewItems falls back to default items and caps the list at four", () => {
  assert.equal(getPreviewItems(null).length, DEFAULT_PREVIEW_ITEMS.length);

  const previewItems = Array.from({ length: 6 }, (_, index) => ({
    name: `item-${index}`,
    kind: "Skill",
    meta: "Skill",
    tone: "skill",
  }));

  assert.deepEqual(
    getPreviewItems({ items: previewItems }).map((item) => item.name),
    ["item-0", "item-1", "item-2", "item-3"],
  );
});

test("getSummaryCards uses preview counts when available and stable defaults otherwise", () => {
  assert.deepEqual(getSummaryCards(null), [
    { label: "Skills", value: 1 },
    { label: "Agents", value: 1 },
    { label: "MCPs", value: 1 },
    { label: "Commands", value: 0 },
    { label: "Configs", value: 1 },
  ]);

  assert.deepEqual(
    getSummaryCards({
      summary: {
        skills: 3,
        agents: 2,
        mcpServers: 4,
        commands: 1,
        configs: 2,
      },
    }),
    [
      { label: "Skills", value: 3 },
      { label: "Agents", value: 2 },
      { label: "MCPs", value: 4 },
      { label: "Commands", value: 1 },
      { label: "Configs", value: 2 },
    ],
  );
});

test("getShareFeedback returns the correct labels for copied, ready, and failed copy states", () => {
  assert.deepEqual(getShareFeedback("copied"), {
    badge: "Copied to clipboard",
    detail: "Share it now or copy it again if you need another pass.",
    copyLabel: "Copy again",
    isSuccess: true,
  });

  assert.deepEqual(getShareFeedback("ready-not-copied"), {
    badge: "Link ready",
    detail: "Share it now or copy it manually if you need another pass.",
    copyLabel: "Copy link",
    isSuccess: false,
  });

  assert.deepEqual(getShareFeedback("copy-failed"), {
    badge: "Clipboard blocked",
    detail: "The link is ready, but your browser blocked clipboard access. Copy it manually.",
    copyLabel: "Copy link",
    isSuccess: false,
  });
});

test("getPreviewPanelState returns preview copy before publish and published copy after publish", () => {
  assert.deepEqual(getPreviewPanelState({ generatedUrl: "", preview: null, effectiveEntryCount: 0 }), {
    chipLabel: "Preview",
    stateLabel: "Landing sample",
    isReady: false,
    title: "Worker package",
    copy: "Review the inferred package before publishing a public import page.",
    mode: "preview",
  });

  assert.deepEqual(getPreviewPanelState({ generatedUrl: "", preview: { items: [] }, effectiveEntryCount: 1 }), {
    chipLabel: "Preview",
    stateLabel: "Ready to publish",
    isReady: true,
    title: "Worker package",
    copy: "Review the inferred package before publishing a public import page.",
    mode: "preview",
  });

  assert.deepEqual(getPreviewPanelState({ generatedUrl: "https://share.openwork.software/b/abc", preview: { items: [] }, effectiveEntryCount: 1 }), {
    chipLabel: "Published link",
    stateLabel: "Published",
    isReady: true,
    title: "Share link ready",
    copy: "Your worker package is published. Anyone with this link can import it directly into OpenWork.",
    mode: "published",
  });
});

test("getPublishWarnings only shows advisory warnings before publish", () => {
  assert.deepEqual(getPublishWarnings({ generatedUrl: "", warnings: ["Skipped file"] }), {
    title: "Review before sharing",
    copy: "Some files were skipped or adjusted. Check these before generating a public link.",
    items: ["Skipped file"],
  });

  assert.equal(getPublishWarnings({ generatedUrl: "https://share.openwork.software/b/abc", warnings: ["Skipped file"] }), null);
  assert.equal(getPublishWarnings({ generatedUrl: "", warnings: [] }), null);
});

test("getPublishedWarnings only shows after publish and always includes a visible state", () => {
  assert.equal(getPublishedWarnings({ generatedUrl: "", warnings: ["Skipped file"] }), null);

  assert.deepEqual(getPublishedWarnings({ generatedUrl: "https://share.openwork.software/b/abc", warnings: ["Skipped file"] }), {
    title: "Warnings",
    copy: "Review any files that were skipped.",
    items: [{ text: "Skipped file", empty: false }],
  });

  assert.deepEqual(getPublishedWarnings({ generatedUrl: "https://share.openwork.software/b/abc", warnings: [] }), {
    title: "Warnings",
    copy: "Review any files that were skipped.",
    items: [{ text: "No warnings. Package is clean.", empty: true }],
  });
});
