import test from "node:test";
import assert from "node:assert/strict";

import { buildBundleUrls, renderBundlePage, wantsDownload } from "./render-bundle-page.ts";
import type { RequestLike } from "../_lib/types.ts";

function makeReq({ accept = "", query = {}, host = "share.openworklabs.com" }: { accept?: string; query?: Record<string, string>; host?: string } = {}): RequestLike {
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

test("wantsDownload only enables on download=1", () => {
  assert.equal(wantsDownload(makeReq({ query: { download: "1" } })), true);
  assert.equal(wantsDownload(makeReq({ query: { download: "0" } })), false);
  assert.equal(wantsDownload(makeReq()), false);
});

test("buildBundleUrls uses the fixed share origin", () => {
  const urls = buildBundleUrls(makeReq({ host: "example.test" }), "01ABC");
  assert.equal(urls.shareUrl, "https://share.openworklabs.com/b/01ABC");
  assert.equal(urls.jsonUrl, "https://share.openworklabs.com/b/01ABC/data");
  assert.equal(urls.downloadUrl, "https://share.openworklabs.com/b/01ABC/data?download=1");
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
    req: makeReq({ accept: "text/html", host: "share.openworklabs.com" }),
  });

  assert.match(html, /data-openwork-share="true"/);
  assert.match(html, /data-openwork-bundle-type="skill"/);
  assert.match(html, /meta name="openwork:bundle-id" content="01TEST"/);
  assert.match(html, /\/b\/01TEST\/data/);
  assert.match(html, /openwork:\/\/import-bundle\?/);
  assert.match(html, /ow_bundle=https%3A%2F%2Fshare\.openworklabs\.com%2Fb%2F01TEST/);
  assert.match(html, /ow_intent=new_worker/);
  assert.match(html, /ow_source=share_service/);
  assert.match(html, /id="openwork-bundle-json" type="application\/json"/);
  assert.match(html, /demo \\u003c\/script\\u003e skill/);
  assert.doesNotMatch(html, /Open in app to choose where to add this skill\./);
  assert.doesNotMatch(html, /Bundle details/);
  assert.doesNotMatch(html, /Raw endpoints/);
  assert.match(html, /skill\.md/);
  assert.match(html, /Open in OpenWork app/);
  assert.match(html, /Open in an OpenWork den/);
  assert.doesNotMatch(html, /Open in web app/);
  assert.doesNotMatch(html, /Copy share link/);
});

test("renderBundlePage shows workspace profile metadata", () => {
  const rawJson = JSON.stringify({
    schemaVersion: 1,
    type: "workspace-profile",
    name: "Team Workspace",
    workspace: {
      opencode: { model: "gpt-5.3" },
      openwork: { reload: { auto: true } },
      skills: [{ name: "workspace-guide", content: "..." }, { name: "skill-creator", content: "..." }],
      commands: [{ name: "standup", template: "..." }],
    },
  });

  const html = renderBundlePage({
    id: "01WORKSPACE",
    rawJson,
    req: makeReq({ accept: "text/html", host: "share.openworklabs.com" }),
  });

  assert.match(html, /Open the bundle in OpenWork/);
  assert.match(html, /Choose the destination worker/);
  assert.match(html, /Happy OpenWorking!/);
  assert.match(html, /Skills:/);
  assert.doesNotMatch(html, /Bundle details/);
  assert.doesNotMatch(html, /Raw endpoints/);
});
