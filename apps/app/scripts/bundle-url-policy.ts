import { strict as assert } from "node:assert";

import { describeBundleUrlTrust, isConfiguredBundlePublisherUrl } from "../src/app/bundles/url-policy";

const trusted = describeBundleUrlTrust(
  "https://share.openworklabs.com/b/01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "https://share.openworklabs.com",
);

assert.deepEqual(trusted, {
  trusted: true,
  bundleId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  actualOrigin: "https://share.openworklabs.com",
  configuredOrigin: "https://share.openworklabs.com",
});

const untrusted = describeBundleUrlTrust(
  "https://evil.example/b/01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "https://share.openworklabs.com",
);

assert.deepEqual(untrusted, {
  trusted: false,
  bundleId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  actualOrigin: "https://evil.example",
  configuredOrigin: "https://share.openworklabs.com",
});

assert.equal(
  isConfiguredBundlePublisherUrl(
    "https://share.openworklabs.com/b/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "https://share.openworklabs.com",
  ),
  true,
);

assert.equal(
  isConfiguredBundlePublisherUrl(
    "https://share.openworklabs.com/not-a-bundle",
    "https://share.openworklabs.com",
  ),
  false,
);

console.log("bundle-url-policy ok");
