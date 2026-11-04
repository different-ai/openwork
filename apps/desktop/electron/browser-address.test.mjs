import assert from "node:assert/strict";
import test from "node:test";

import { resolveAddressBarInput } from "./browser-address.mjs";

test("full addresses open as typed", () => {
  assert.equal(resolveAddressBarInput("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(resolveAddressBarInput("  http://intranet.example.org  "), "http://intranet.example.org");
});

test("bare domains open over https", () => {
  assert.equal(resolveAddressBarInput("example.com"), "https://example.com");
  assert.equal(resolveAddressBarInput("docs.example.co.uk/path#top"), "https://docs.example.co.uk/path#top");
  assert.equal(resolveAddressBarInput("example.com:8443"), "https://example.com:8443");
  assert.equal(resolveAddressBarInput("10.0.0.2:8080/admin"), "https://10.0.0.2:8080/admin");
});

test("local dev servers open over http", () => {
  assert.equal(resolveAddressBarInput("localhost:3000"), "http://localhost:3000");
  assert.equal(resolveAddressBarInput("localhost"), "http://localhost");
  assert.equal(resolveAddressBarInput("127.0.0.1:5173/app"), "http://127.0.0.1:5173/app");
  assert.equal(resolveAddressBarInput("[::1]:8080"), "http://[::1]:8080");
});

test("anything else is searched", () => {
  assert.equal(resolveAddressBarInput("weather in paris"), "https://www.google.com/search?q=weather%20in%20paris");
  assert.equal(resolveAddressBarInput("openwork"), "https://www.google.com/search?q=openwork");
  assert.equal(resolveAddressBarInput("what is 2+2?"), "https://www.google.com/search?q=what%20is%202%2B2%3F");
  assert.equal(resolveAddressBarInput("example.com is down"), "https://www.google.com/search?q=example.com%20is%20down");
  assert.equal(resolveAddressBarInput("version 1.2"), "https://www.google.com/search?q=version%201.2");
});

test("empty input stays on a blank page", () => {
  assert.equal(resolveAddressBarInput(""), "about:blank");
  assert.equal(resolveAddressBarInput("   "), "about:blank");
  assert.equal(resolveAddressBarInput(undefined), "about:blank");
});

test("other schemes are searched rather than opened", () => {
  assert.equal(resolveAddressBarInput("javascript:alert(1)"), "https://www.google.com/search?q=javascript%3Aalert(1)");
  assert.equal(resolveAddressBarInput("file:///etc/passwd"), "https://www.google.com/search?q=file%3A%2F%2F%2Fetc%2Fpasswd");
});
