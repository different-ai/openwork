import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PREVIEW_ITEMS,
  getPackageStatus,
  getPreviewItems,
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

test("getPackageStatus shows neutral when nothing is selected", () => {
  const status = getPackageStatus({ generatedUrl: "", warnings: [], preview: null, effectiveEntryCount: 0, busy: false });
  assert.equal(status.severity, "neutral");
  assert.equal(status.items.length, 0);
});

test("getPackageStatus shows success when preview is ready with no warnings", () => {
  const status = getPackageStatus({ generatedUrl: "", warnings: [], preview: { items: [{ name: "test" }] }, effectiveEntryCount: 1, busy: false });
  assert.equal(status.severity, "success");
  assert.match(status.label, /no issues/i);
});

test("getPackageStatus shows warn severity for secret redactions", () => {
  const status = getPackageStatus({
    generatedUrl: "",
    warnings: ["Redacted 1 potential secret in config.json: opencode.token"],
    preview: { items: [{ name: "test" }] },
    effectiveEntryCount: 1,
    busy: false,
  });
  assert.equal(status.severity, "warn");
  assert.match(status.label, /redacted/i);
  assert.equal(status.items.length, 1);
});

test("getPackageStatus shows info severity for non-secret warnings", () => {
  const status = getPackageStatus({
    generatedUrl: "",
    warnings: ["Ignored unsupported file: readme.txt"],
    preview: { items: [{ name: "test" }] },
    effectiveEntryCount: 1,
    busy: false,
  });
  assert.equal(status.severity, "info");
  assert.equal(status.items.length, 1);
});

test("getPackageStatus shows success after publish with no warnings", () => {
  const status = getPackageStatus({
    generatedUrl: "https://share.openwork.software/b/abc",
    warnings: [],
    preview: { items: [{ name: "test" }] },
    effectiveEntryCount: 1,
    busy: false,
  });
  assert.equal(status.severity, "success");
  assert.match(status.label, /no issues/i);
});
