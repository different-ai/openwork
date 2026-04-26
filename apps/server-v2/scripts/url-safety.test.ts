// Standalone test (no deps beyond Node) for the SSRF normalizeUrl fix.
// Run with:
//   node --experimental-strip-types --test apps/server-v2/scripts/url-safety.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeUrl, isBlockedLiteralAddress } from "../src/services/url-safety.ts";

test("normalizeUrl rejects the EC2/GCE metadata IP 169.254.169.254", () => {
  assert.throws(
    () => normalizeUrl("http://169.254.169.254/latest/meta-data"),
    /non-routable|blocked/i,
  );
});

test("normalizeUrl rejects loopback addresses", () => {
  assert.throws(() => normalizeUrl("http://127.0.0.1/"), /non-routable|blocked/i);
  assert.throws(() => normalizeUrl("http://127.1.2.3/"), /non-routable|blocked/i);
  assert.throws(() => normalizeUrl("http://[::1]/"), /non-routable|blocked/i);
});

test("normalizeUrl rejects 'localhost' and friends", () => {
  assert.throws(() => normalizeUrl("http://localhost/"), /blocked/i);
  assert.throws(() => normalizeUrl("http://service.local/"), /blocked/i);
  assert.throws(() => normalizeUrl("http://api.localhost/"), /blocked/i);
});

test("normalizeUrl rejects RFC 1918 private ranges", () => {
  assert.throws(() => normalizeUrl("http://10.0.0.1/"), /non-routable/i);
  assert.throws(() => normalizeUrl("http://192.168.1.1/"), /non-routable/i);
  assert.throws(() => normalizeUrl("http://172.16.0.5/"), /non-routable/i);
  assert.throws(() => normalizeUrl("http://172.31.255.254/"), /non-routable/i);
});

test("normalizeUrl allows public IPv4 octets near (but not in) RFC 1918", () => {
  assert.ok(normalizeUrl("http://172.15.0.1/"));
  assert.ok(normalizeUrl("http://172.32.0.1/"));
  assert.ok(normalizeUrl("http://193.168.1.1/"));
});

test("normalizeUrl rejects non-http(s) protocols", () => {
  assert.throws(() => normalizeUrl("file:///etc/passwd"), /protocol/i);
  assert.throws(() => normalizeUrl("ftp://example.com/"), /protocol/i);
});

test("normalizeUrl returns a clean URL for legitimate hosts", () => {
  assert.equal(normalizeUrl("https://example.com/"), "https://example.com");
  assert.equal(normalizeUrl("example.com"), "http://example.com");
  assert.equal(normalizeUrl("https://api.example.com/v2/"), "https://api.example.com/v2");
});

test("isBlockedLiteralAddress recognises IPv4-mapped IPv6 metadata addresses", () => {
  assert.equal(isBlockedLiteralAddress("::ffff:169.254.169.254"), true);
  // Hex form of the same address.
  assert.equal(isBlockedLiteralAddress("::ffff:a9fe:a9fe"), true);
});
