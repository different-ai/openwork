import assert from "node:assert/strict";
import { test } from "node:test";
import { createRemoteAccessFeature } from "../electron/remote-access-feature.mjs";

const baseUrl = "https://portal.example/api/den";
test("restored access stays closed until account state is known, including org transitions", async () => {
  let requests = 0;
  const feature = createRemoteAccessFeature({
    baseUrls: [baseUrl],
    fetchImpl: async () => {
      requests++;
      return new Response(JSON.stringify({ features: { remoteAccess: true } }));
    },
  });
  assert.equal(await feature.enabled(), false);
  assert.equal(requests, 0);
  feature.configure(null);
  assert.equal(await feature.enabled(), true);
  feature.configure({ pending: true });
  assert.equal(await feature.enabled(), false);
  assert.throws(() =>
    feature.configure({
      baseUrl: "https://other.example",
      token: "test",
      orgId: "org",
    }),
  );
  assert.equal(await feature.enabled(), false);
});
test("signed-out feature comes from the fixed public endpoint and missing means off", async () => {
  const calls = [];
  const feature = createRemoteAccessFeature({
    baseUrls: [baseUrl],
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return new Response(JSON.stringify({ features: {} }));
    },
  });
  feature.configure(null);
  assert.equal(await feature.enabled(), false);
  assert.equal(calls[0][0], `${baseUrl}/v1/features`);
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].headers.Authorization, undefined);
});

test("signed-in feature is fetched independently with bound org context; token is never returned", async () => {
  let request;
  const feature = createRemoteAccessFeature({
    baseUrls: [baseUrl],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ features: { remoteAccess: true } }));
    },
  });
  feature.configure({ baseUrl, token: "private-session", orgId: "org-123" });
  assert.equal(await feature.enabled(), true);
  assert.equal(request.url, `${baseUrl}/v1/org`);
  assert.equal(request.options.headers["x-openwork-org-id"], "org-123");
  assert.equal(request.options.headers.Authorization, "Bearer private-session");
  assert.ok(!JSON.stringify(feature).includes("private-session"));
  assert.throws(
    () =>
      feature.configure({
        baseUrl: "https://other.example",
        token: "private-session",
        orgId: "org-123",
      }),
    /UNTRUSTED_FEATURE_ORIGIN/,
  );
});

test("feature refresh honors kill/off, and an unreachable deployment fails closed", async () => {
  let now = 0,
    allow = true,
    fail = false;
  const feature = createRemoteAccessFeature({
    baseUrls: [baseUrl],
    now: () => now,
    fetchImpl: async () => {
      if (fail) throw new Error("network");
      return new Response(
        JSON.stringify({ features: { remoteAccess: allow } }),
      );
    },
  });
  feature.configure(null);
  assert.equal(await feature.enabled(), true);
  now += 16000;
  allow = false;
  assert.equal(await feature.enabled(), false);
  now += 16000;
  fail = true;
  assert.equal(await feature.enabled(), false);
});

test("an org change invalidates an in-flight allow response", async () => {
  let complete;
  const feature = createRemoteAccessFeature({
    baseUrls: [baseUrl],
    fetchImpl: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  feature.configure(null);
  const pending = feature.enabled();
  feature.configure({ baseUrl, token: "next", orgId: "next-org" });
  complete(new Response(JSON.stringify({ features: { remoteAccess: true } })));
  assert.equal(await pending, false);
});

test("explicit local qualification policy bypasses network only when supplied by main", async () => {
  for (const enabled of [true, false]) {
    const feature = createRemoteAccessFeature({
      baseUrls: [baseUrl],
      localPolicy: { enabled },
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    });
    assert.equal(await feature.enabled(), enabled);
  }
});
