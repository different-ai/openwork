import test from "node:test";
import assert from "node:assert/strict";

import { buildCanonicalRequest } from "./request-like.ts";
import { buildCorsHeaders, validateTrustedOrigin } from "./publish-security.ts";

test("buildCanonicalRequest pins legacy publish routes to the fixed share origin", () => {
  const request = buildCanonicalRequest({
    pathname: "/v1/bundles",
    method: "POST",
    headers: {
      host: "evil.example",
      "x-forwarded-host": "evil.example",
      origin: "https://openworklabs.com",
    },
  });

  assert.equal(new URL(request.url).origin, "https://share.openworklabs.com");
});

test("buildCorsHeaders reflects only trusted publisher origins", () => {
  const trustedRequest = buildCanonicalRequest({
    pathname: "/v1/bundles",
    method: "POST",
    headers: { origin: "https://openworklabs.com" },
  });
  const trustedHeaders = buildCorsHeaders(trustedRequest);

  assert.equal(trustedHeaders["Access-Control-Allow-Origin"], "https://openworklabs.com");
  assert.equal(trustedHeaders.Vary, "Origin");

  const untrustedRequest = buildCanonicalRequest({
    pathname: "/v1/bundles",
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  const untrustedHeaders = buildCorsHeaders(untrustedRequest);

  assert.equal(untrustedHeaders["Access-Control-Allow-Origin"], undefined);
  assert.equal(validateTrustedOrigin(untrustedRequest).ok, false);
});
