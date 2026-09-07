// @ts-nocheck -- the captured webRequest listener is assigned by a fake session.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
    ipc: new EventEmitter(),
    isDestroyed: () => false,
    executeJavaScript() {
      assert.fail("Policy must never execute in the page's main world.");
    },
    send(channel, replyChannel, childIndex) {
      assert.equal(channel, "openwork:webmcp:read-policy");
      this.ipc.emit(replyChannel, { senderFrame: this }, {
        ...this.runtimePolicy,
        embedding: childIndex === null ? null : this.embedding,
      });
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

test("page-supplied overrides cannot replace isolated runtime facts or response opt-outs", async () => {
  let listener;
  const policy = createWebMcpFramePolicy({
    webRequest: { onHeadersReceived(_filter, candidate) { listener = candidate; } },
  });
  policy.install();
  const frame = fakeFrame("https://app.example");
  const forged = { originAgentCluster: true, domainMatchesHost: true };
  for (const runtimePolicy of [
    { originAgentCluster: false, domainMatchesHost: true },
    { originAgentCluster: true, domainMatchesHost: false },
    { domainMatchesHost: true },
  ]) {
    frame.runtimePolicy = runtimePolicy;
    assert.deepEqual(await policy.checkFrame(frame, forged), {
      allowed: true, originKeyed: false, reason: "non_origin_keyed",
    });
    assert.equal(frame.ipc.eventNames().length, 0);
  }
  frame.runtimePolicy = forged;
  assert.equal((await policy.checkFrame(frame)).originKeyed, true);
  listener({ resourceType: "mainFrame", frame, url: frame.url, responseHeaders: { "Origin-Agent-Cluster": ["?0"] } }, () => {});
  assert.deepEqual(await policy.checkFrame(frame, forged), {
    allowed: true, originKeyed: false, reason: "origin_agent_cluster_opt_out",
  });
});

test("missing, foreign, and navigated preload replies fail closed and release their listeners", async () => {
  const policy = createWebMcpFramePolicy({});
  const frame = fakeFrame("https://app.example");
  const other = fakeFrame("https://app.example");
  for (const send of [
    () => { throw new Error("No isolated preload"); },
    (_channel, reply) => frame.ipc.emit(reply, { senderFrame: other }, frame.runtimePolicy),
    (_channel, reply) => {
      frame.ipc.emit(reply, { senderFrame: frame }, frame.runtimePolicy);
      frame.url += "?navigated";
    },
  ]) {
    frame.send = send;
    assert.equal((await policy.checkFrame(frame)).originKeyed, false);
    assert.equal(frame.ipc.eventNames().length, 0);
  }
});
