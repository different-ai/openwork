import test from "node:test";
import assert from "node:assert/strict";

import { buildBundlePreviewSelections, buildBundleUrls, buildOgImageUrls } from "./share-utils.ts";

function withEnv(name: string, value: string | undefined, run: () => void) {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test("buildBundlePreviewSelections slugifies shared skill filenames", () => {
  const selections = buildBundlePreviewSelections({
    schemaVersion: 1,
    type: "skill",
    name: "agent-creator",
    description: "",
    trigger: "",
    content: "# Agent Creator",
    workspace: null,
    skills: [],
    commands: [],
  });

  assert.equal(selections[0]?.filename, "agent-creator.md");
  assert.equal(selections[0]?.label, "Skill");
});

test("buildOgImageUrls returns typed platform variants", () => {
  const urls = buildOgImageUrls(
    {
      headers: {
        host: "share.openworklabs.com",
        "x-forwarded-proto": "https",
      },
      query: {},
    },
    "01TESTPREVIEW",
  );

  assert.equal(urls.default, "https://share.openworklabs.com/og/01TESTPREVIEW");
  assert.equal(urls.twitter, "https://share.openworklabs.com/og/01TESTPREVIEW?variant=twitter");
  assert.equal(urls.byVariant.facebook, "https://share.openworklabs.com/og/01TESTPREVIEW");
  assert.equal(urls.byVariant.linkedin, "https://share.openworklabs.com/og/01TESTPREVIEW?variant=linkedin");
  assert.equal(urls.byVariant.slack, "https://share.openworklabs.com/og/01TESTPREVIEW?variant=slack");
  assert.equal(urls.byVariant.whatsapp, "https://share.openworklabs.com/og/01TESTPREVIEW?variant=whatsapp");
});

test("buildBundleUrls ignores forwarded hosts and uses the fixed default share origin", () => {
  withEnv("PUBLIC_BASE_URL", undefined, () => {
    const urls = buildBundleUrls(
      {
        headers: {
          host: "evil.example",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "http",
        },
        query: {},
      },
      "01ABC",
    );

    assert.equal(urls.shareUrl, "https://share.openworklabs.com/b/01ABC");
    assert.equal(urls.jsonUrl, "https://share.openworklabs.com/b/01ABC/data");
    assert.equal(urls.downloadUrl, "https://share.openworklabs.com/b/01ABC/data?download=1");
  });
});

test("buildBundleUrls respects PUBLIC_BASE_URL when explicitly configured", () => {
  withEnv("PUBLIC_BASE_URL", "https://share.staging.openworklabs.com/", () => {
    const urls = buildBundleUrls(
      {
        headers: {
          host: "ignored.example",
          "x-forwarded-host": "ignored.example",
        },
        query: {},
      },
      "01CFG",
    );

    assert.equal(urls.shareUrl, "https://share.staging.openworklabs.com/b/01CFG");
  });
});
