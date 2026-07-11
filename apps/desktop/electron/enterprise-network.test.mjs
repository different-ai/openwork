import assert from "node:assert/strict";
import test from "node:test";

import { createEnterpriseConnectionGuard, isOpenWorkCloudUrl } from "./enterprise-network.mjs";

test("recognizes OpenWork Cloud without matching lookalike domains", () => {
  assert.equal(isOpenWorkCloudUrl("https://api.openworklabs.com/v1/me"), true);
  assert.equal(isOpenWorkCloudUrl("https://openworklabs.com/"), true);
  assert.equal(isOpenWorkCloudUrl("https://openworklabs.com.attacker.example/"), false);
  assert.equal(isOpenWorkCloudUrl("https://openwork.acme.example/"), false);
});

test("enterprise guard blocks vendor cloud only until configuration exists", () => {
  const guard = createEnterpriseConnectionGuard({ enterprise: true });
  assert.equal(guard.isLocked(), true);
  assert.equal(guard.shouldBlock("https://api.openworklabs.com/v1/me"), true);
  assert.equal(guard.shouldBlock("https://openwork.acme.example/v1/me"), false);

  guard.setConfigured(true);
  assert.equal(guard.isLocked(), false);
  assert.equal(guard.shouldBlock("https://api.openworklabs.com/v1/me"), false);

  guard.setConfigured(false);
  assert.equal(guard.isLocked(), true);
  assert.equal(guard.shouldBlock("https://app.openworklabs.com/"), true);
});

test("standard builds never install the vendor-cloud block", () => {
  const guard = createEnterpriseConnectionGuard({ enterprise: false });
  assert.equal(guard.shouldBlock("https://api.openworklabs.com/v1/me"), false);
});

test("installed enterprise guard cancels vendor-cloud requests until configured", () => {
  const guard = createEnterpriseConnectionGuard({ enterprise: true });
  let filter = null;
  /** @type {Array<(details: { url: string }, callback: (result: { cancel: boolean }) => void) => void>} */
  const handlers = [];
  guard.install({
    webRequest: {
      onBeforeRequest(nextFilter, nextHandler) {
        filter = nextFilter;
        handlers.push(nextHandler);
      },
    },
  });

  assert.deepEqual(filter, {
    urls: ["https://openworklabs.com/*", "https://*.openworklabs.com/*"],
  });
  const handler = handlers[0];
  assert.ok(handler);

  let blocked = null;
  handler({ url: "https://api.openworklabs.com/v1/me" }, (result) => {
    blocked = result;
  });
  assert.deepEqual(blocked, { cancel: true });

  let customer = null;
  handler({ url: "https://openwork.acme.example/v1/me" }, (result) => {
    customer = result;
  });
  assert.deepEqual(customer, { cancel: false });

  guard.setConfigured(true);
  let unlocked = null;
  handler({ url: "https://api.openworklabs.com/v1/me" }, (result) => {
    unlocked = result;
  });
  assert.deepEqual(unlocked, { cancel: false });
});
