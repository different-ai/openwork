import assert from "node:assert/strict";
import test from "node:test";

import { nativeAppLinkForHttps, registeredNativeAppLinkForHttps } from "./native-app-links.mjs";

test("maps only documented Notion, Linear, and Slack HTTPS shapes", () => {
  assert.deepEqual(nativeAppLinkForHttps("https://www.notion.so/Roadmap-0123456789abcdef0123456789abcdef?pvs=4#comments"), {
    protocol: "notion:",
    url: "notion://www.notion.so/Roadmap-0123456789abcdef0123456789abcdef?pvs=4#comments",
  });
  assert.deepEqual(nativeAppLinkForHttps("https://notion.so/acme/Planning-01234567-89ab-cdef-0123-456789abcdef"), {
    protocol: "notion:",
    url: "notion://www.notion.so/acme/Planning-01234567-89ab-cdef-0123-456789abcdef",
  });
  assert.deepEqual(nativeAppLinkForHttps("https://linear.app/issue/ENG-123"), {
    protocol: "linear:",
    url: "linear://linear.app/issue/ENG-123",
  });
  assert.deepEqual(nativeAppLinkForHttps("https://app.slack.com/client/T123ABC456/C456DEF789"), {
    protocol: "slack:",
    url: "slack://channel?team=T123ABC456&id=C456DEF789",
  });
});

test("rejects unmapped, ambiguous, and unsafe HTTPS addresses", () => {
  for (const url of [
    "http://www.notion.so/Roadmap-0123456789abcdef0123456789abcdef",
    "https://user:secret@www.notion.so/Roadmap-0123456789abcdef0123456789abcdef",
    "https://www.notion.so:444/Roadmap-0123456789abcdef0123456789abcdef",
    "https://www.notion.so:443/Roadmap-0123456789abcdef0123456789abcdef",
    "https://www.notion.so.evil.example/Roadmap-0123456789abcdef0123456789abcdef",
    "https://xn--noton-fza.so/Roadmap-0123456789abcdef0123456789abcdef",
    "https://www.notion.so/pricing",
    "https://www.notion.so/acme/folder/Roadmap-0123456789abcdef0123456789abcdef",
    "https://www.notion.so/acme%2fRoadmap-0123456789abcdef0123456789abcdef",
    "https://www.notion.so/acme/../Roadmap-0123456789abcdef0123456789abcdef",
    "https://www.notion.so/acme/%2e%2e/Roadmap-0123456789abcdef0123456789abcdef",
    "https://www.notion.so//Roadmap-0123456789abcdef0123456789abcdef",
    "https://linear.app/issue/eng-123",
    "https://linear.app/acme/issue/ENG-123",
    "https://linear.app/issue/ENG-123?source=chat",
    "https://app.slack.com/client/T123ABC456/general",
    "https://app.slack.com/client/T123ABC456/C456DEF789/thread/p1234567890000100",
    "https://app.slack.com/client/T123ABC456/C456DEF789?foo=bar",
    "https://github.com/different-ai/openwork",
    "https://example.com/notion.so/Roadmap-0123456789abcdef0123456789abcdef",
  ]) assert.equal(nativeAppLinkForHttps(url), null, url);
});

test("shows the actual registered handler name and hides absent, invalid, or failing lookups", () => {
  const url = "https://www.notion.so/Roadmap-0123456789abcdef0123456789abcdef";
  const lookedUp = [];
  assert.deepEqual(registeredNativeAppLinkForHttps(url, (nativeUrl) => {
    lookedUp.push(nativeUrl);
    return "Acme Notes";
  }), {
    protocol: "notion:",
    url: "notion://www.notion.so/Roadmap-0123456789abcdef0123456789abcdef",
    name: "Acme Notes",
  });
  assert.deepEqual(lookedUp, ["notion://www.notion.so/Roadmap-0123456789abcdef0123456789abcdef"]);
  assert.equal(registeredNativeAppLinkForHttps(url, () => ""), null);
  assert.equal(registeredNativeAppLinkForHttps(url, () => "Unsafe\nName"), null);
  assert.equal(registeredNativeAppLinkForHttps(url, () => { throw new Error("lookup failed"); }), null);
  assert.equal(registeredNativeAppLinkForHttps("https://example.com", () => "Default Browser"), null);
});
