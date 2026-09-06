// @ts-nocheck -- the captured webRequest listener is assigned by a fake session.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createWebMcpFramePolicy,
  iframeAllowsTools,
  permissionsPolicyAllows,
} from "./webmcp-policy.mjs";

test("parses WebMCP response and iframe Permissions Policy allowlists", () => {
  assert.equal(permissionsPolicyAllows("camera=(), tools=()", "https://app.example", "https://app.example"), false);
  assert.equal(permissionsPolicyAllows("tools=(self)", "https://app.example", "https://app.example"), true);
  assert.equal(permissionsPolicyAllows("tools=(self)", "https://app.example", "https://child.example"), false);
  assert.equal(permissionsPolicyAllows('tools=("https://child.example")', "https://app.example", "https://child.example"), true);
  assert.equal(permissionsPolicyAllows("camera=()", "https://app.example", "https://app.example"), null);

  // The bare shorthand delegates to the iframe's source origin only: a frame
  // that navigated elsewhere, or whose source origin is unknown, is not covered.
  assert.equal(iframeAllowsTools("tools", "https://app.example", "https://child.example", "https://child.example"), true);
  assert.equal(iframeAllowsTools("tools", "https://app.example", "https://evil.example", "https://child.example"), false);
  assert.equal(iframeAllowsTools("tools", "https://app.example", "https://child.example"), false);
  assert.equal(iframeAllowsTools("tools", "https://app.example", "https://child.example", null), false);
  assert.equal(iframeAllowsTools("tools *", "https://app.example", "https://evil.example", "https://child.example"), true);
  assert.equal(iframeAllowsTools("tools 'src'", "https://app.example", "https://evil.example", "https://child.example"), false);
  assert.equal(iframeAllowsTools("camera; tools 'none'", "https://app.example", "https://child.example"), false);
  assert.equal(iframeAllowsTools("tools *", "https://app.example", "https://child.example"), true);
  assert.equal(iframeAllowsTools("tools 'self'", "https://app.example", "https://child.example"), false);
  assert.equal(iframeAllowsTools("camera", "https://app.example", "https://child.example"), false);
});

function fakeFrame(origin, parent = null) {
  const frame = {
    origin,
    url: `${origin}/page`,
    parent,
    frames: [],
    detached: false,
    runtimePolicy: { originAgentCluster: true, domainMatchesHost: true },
    embedding: { allow: "", sourceOrigin: origin },
    isDestroyed: () => false,
    async executeJavaScript(source) {
      return source.includes("querySelectorAll") ? this.embedding : this.runtimePolicy;
    },
  };
  if (parent) parent.frames.push(frame);
  return frame;
}

test("frame policy denies undelegated cross-origin tools and non-origin-keyed documents", async () => {
  let listener = null;
  const policy = createWebMcpFramePolicy({
    webRequest: {
      onHeadersReceived(_filter, candidate) { listener = candidate; },
    },
  });
  policy.install();
  assert.equal(typeof listener, "function");

  const top = fakeFrame("https://app.example");
  const child = fakeFrame("https://child.example", top);
  listener({
    resourceType: "mainFrame",
    frame: top,
    url: top.url,
    responseHeaders: { "Permissions-Policy": ["tools=(self \"https://child.example\")"] },
  }, () => {});
  listener({ resourceType: "subFrame", frame: child, url: child.url, responseHeaders: {} }, () => {});

  assert.deepEqual(await policy.checkFrame(child), {
    allowed: false,
    originKeyed: true,
    reason: "missing_iframe_delegation",
  });

  top.embedding = { allow: "tools", sourceOrigin: "https://child.example" };
  assert.deepEqual(await policy.checkFrame(child), {
    allowed: true,
    originKeyed: true,
    reason: "allowed",
  });

  child.runtimePolicy.originAgentCluster = false;
  assert.deepEqual(await policy.checkFrame(child), {
    allowed: true,
    originKeyed: false,
    reason: "non_origin_keyed",
  });
});

test("an explicit ancestor tools=() response policy cannot be expanded by an iframe", async () => {
  let listener = null;
  const policy = createWebMcpFramePolicy({
    webRequest: { onHeadersReceived(_filter, candidate) { listener = candidate; } },
  });
  policy.install();
  const top = fakeFrame("https://app.example");
  const child = fakeFrame("https://child.example", top);
  top.embedding = { allow: "tools *", sourceOrigin: "https://child.example" };
  listener({
    resourceType: "mainFrame",
    frame: top,
    url: top.url,
    responseHeaders: { "permissions-policy": ["tools=()"] },
  }, () => {});
  assert.equal((await policy.checkFrame(child)).allowed, false);
});
