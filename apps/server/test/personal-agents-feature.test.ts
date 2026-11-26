import assert from "node:assert/strict";
import { test } from "node:test";

import { createPersonalAgentsFeatureLookup } from "../src/personal-agents-feature.js";

const session = { baseUrl: "https://den.acme.test", orgId: "org-1", token: "test-token" };

function featureResponse(enabled: boolean) {
  return Response.json({ features: { personalAgents: enabled } });
}

test("cold discovery answers off while one shared request warms the cache", async () => {
  const response = Promise.withResolvers<Response>();
  const requests: { url: string; init: RequestInit }[] = [];
  const lookup = createPersonalAgentsFeatureLookup((url, init) => {
    requests.push({ url, init });
    return response.promise;
  });
  assert.equal(lookup.cached(session), false);
  assert.equal(lookup.cached(session), false);
  const check = lookup.check(session);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://den.acme.test/v1/org");
  assert.equal(requests[0]?.init.method, "GET");
  assert.equal(requests[0]?.init.redirect, "error");
  assert.deepEqual(requests[0]?.init.headers, {
    Accept: "application/json",
    Authorization: "Bearer test-token",
    "x-openwork-org-id": "org-1",
    "x-openwork-legacy-org-id": "org-1",
  });
  response.resolve(featureResponse(true));
  assert.equal(await check, true);
  assert.equal(lookup.cached(session), true);
  assert.equal(requests.length, 1);
});

test("only a literal true flag enables agents", async () => {
  for (const payload of [{ features: { personalAgents: false } }, { features: {} }, {}, { features: { personalAgents: "true" } }]) {
    const lookup = createPersonalAgentsFeatureLookup(async () => Response.json(payload));
    assert.equal(await lookup.check(session), false);
  }
});

test("signed out never looks up the flag, even after it was enabled", async () => {
  let calls = 0;
  const lookup = createPersonalAgentsFeatureLookup(async () => {
    calls++;
    return featureResponse(true);
  });
  assert.equal(lookup.cached(null), false);
  assert.equal(await lookup.check(null), false);
  assert.equal(calls, 0);
  assert.equal(await lookup.check(session), true);
  assert.equal(lookup.cached(null), false);
  assert.equal(await lookup.check(null), false);
  assert.equal(calls, 1);
});

test("network errors, Den errors and invalid responses keep the last known result until a successful refresh", async () => {
  let now = 0;
  let fetchDen = async () => featureResponse(true);
  const lookup = createPersonalAgentsFeatureLookup(() => fetchDen(), () => now);
  assert.equal(await lookup.check(session), true);

  for (const failure of [
    async () => { throw new Error("offline"); },
    async () => new Response("Unauthorized", { status: 401 }),
    async () => new Response("not JSON"),
    async () => Response.json({ features: { personalAgents: "true" } }),
  ]) {
    now += 60_000;
    fetchDen = failure;
    assert.equal(lookup.cached(session), true);
    assert.equal(await lookup.check(session), true);
    assert.equal(lookup.cached(session), true);
  }
  now += 60_000;
  fetchDen = async () => featureResponse(false);
  assert.equal(lookup.cached(session), true);
  assert.equal(await lookup.check(session), false);
  assert.equal(lookup.cached(session), false);
});

test("warm entries do not fetch for 60 seconds and are isolated by Den URL, organization and token", async () => {
  let now = 0;
  let calls = 0;
  const lookup = createPersonalAgentsFeatureLookup(async () => featureResponse(++calls === 1), () => now);

  assert.deepEqual(await Promise.all([lookup.check(session), lookup.check(session)]), [true, true]);
  now = 59_999;
  assert.equal(lookup.cached({ ...session }), true);
  assert.equal(calls, 1);
  for (const other of [{ baseUrl: "https://other.acme.test" }, { orgId: "org-2" }, { token: "other-test-token" }]) {
    assert.equal(lookup.cached({ ...session, ...other }), false);
    assert.equal(await lookup.check({ ...session, ...other }), false);
  }
  assert.equal(calls, 4);
  now = 60_000;
  assert.equal(await lookup.check(session), false);
  assert.equal(calls, 5);
});
