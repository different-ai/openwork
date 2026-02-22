import test from "node:test";
import assert from "node:assert/strict";

import { buildBundleUrls, renderBundlePage, wantsDownload, wantsJsonResponse } from "./render-bundle-page.js";

function makeReq({ accept = "", query = {}, host = "share.openwork.software" } = {}) {
  return {
    query,
    headers: {
      accept,
      host,
      "x-forwarded-proto": "https",
      "x-forwarded-host": host,
    },
  };
}

test("wantsJsonResponse honors explicit format query", () => {
  assert.equal(wantsJsonResponse(makeReq({ query: { format: "json" }, accept: "text/html" })), true);
  assert.equal(wantsJsonResponse(makeReq({ query: { format: "html" }, accept: "application/json" })), false);
});

test("wantsJsonResponse defaults to json unless browser html accept is present", () => {
  assert.equal(wantsJsonResponse(makeReq()), true);
  assert.equal(wantsJsonResponse(makeReq({ accept: "application/json" })), true);
  assert.equal(wantsJsonResponse(makeReq({ accept: "text/html,application/xhtml+xml" })), false);
});

test("wantsDownload only enables on download=1", () => {
  assert.equal(wantsDownload(makeReq({ query: { download: "1" } })), true);
  assert.equal(wantsDownload(makeReq({ query: { download: "0" } })), false);
  assert.equal(wantsDownload(makeReq()), false);
});

test("buildBundleUrls uses forwarded origin", () => {
  const urls = buildBundleUrls(makeReq({ host: "example.test" }), "01ABC");
  assert.equal(urls.shareUrl, "https://example.test/b/01ABC");
  assert.equal(urls.jsonUrl, "https://example.test/b/01ABC?format=json");
  assert.equal(urls.downloadUrl, "https://example.test/b/01ABC?format=json&download=1");
});

test("renderBundlePage includes machine-readable metadata and escaped json script", () => {
  const rawJson = JSON.stringify({
    schemaVersion: 1,
    type: "skill",
    name: "demo </script> skill",
    description: "Install me",
    trigger: "daily",
    content: "# Skill\nHello",
  });

  const html = renderBundlePage({
    id: "01TEST",
    rawJson,
    req: makeReq({ accept: "text/html", host: "share.openwork.software" }),
  });

  assert.match(html, /data-openwork-share="true"/);
  assert.match(html, /data-openwork-bundle-type="skill"/);
  assert.match(html, /meta name="openwork:bundle-id" content="01TEST"/);
  assert.match(html, /\?format=json/);
  assert.match(html, /id="openwork-bundle-json" type="application\/json"/);
  assert.match(html, /demo \\u003c\/script\\u003e skill/);
});
