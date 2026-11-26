import assert from "node:assert/strict";
import { test } from "node:test";

import { createPersonalAgentsFeatureLookup } from "../src/personal-agents-feature.js";

const session = { baseUrl: "https://den.acme.test", orgId: "org-1", token: "test-token" };

test("only the literal true flag enables personal agents, using the signed-in Den session", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const lookup = createPersonalAgentsFeatureLookup(async (url, init) => {
    requests.push({ url, init });
    return Response.json({ features: { personalAgents: true } });
  });
  assert.equal(await lookup(session), true);
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

  for (const payload of [{ features: { personalAgents: false } }, { features: {} }, {}, { features: { personalAgents: "true" } }]) {
    const disabled = createPersonalAgentsFeatureLookup(async () => Response.json(payload));
    assert.equal(await disabled(session), false);
  }
});

test("signed out never looks up the flag, even after it was enabled", async () => {
  let calls = 0;
  const lookup = createPersonalAgentsFeatureLookup(async () => {
    calls++;
    return Response.json({ features: { personalAgents: true } });
  });
  assert.equal(await lookup(null), false);
  assert.equal(await lookup(session), true);
  assert.equal(await lookup(null), false);
  assert.equal(calls, 1);
});

test("a network error, Den error response or invalid JSON leaves personal agents unavailable", async () => {
  const networkError = createPersonalAgentsFeatureLookup(async () => { throw new Error("offline"); });
  const denError = createPersonalAgentsFeatureLookup(async () => Response.json({ features: { personalAgents: true } }, { status: 401 }));
  const invalidJson = createPersonalAgentsFeatureLookup(async () => new Response("not JSON"));
  assert.equal(await networkError(session), false);
  assert.equal(await denError(session), false);
  assert.equal(await invalidJson(session), false);
});

test("personal agent results are cached for 60 seconds per Den URL, organization and token", async () => {
  let now = 0;
  let calls = 0;
  const lookup = createPersonalAgentsFeatureLookup(async () => {
    calls++;
    return Response.json({ features: { personalAgents: calls === 1 } });
  }, () => now);

  assert.deepEqual(await Promise.all([lookup(session), lookup(session)]), [true, true]);
  now = 59_999;
  assert.equal(await lookup({ ...session }), true);
  assert.equal(calls, 1);
  assert.equal(await lookup({ ...session, baseUrl: "https://other.acme.test" }), false);
  assert.equal(await lookup({ ...session, orgId: "org-2" }), false);
  assert.equal(await lookup({ ...session, token: "other-test-token" }), false);
  assert.equal(await lookup({ ...session, token: "other-test-token" }), false);
  assert.equal(calls, 4);
  now = 60_000;
  assert.equal(await lookup(session), false);
  assert.equal(calls, 5);
});
