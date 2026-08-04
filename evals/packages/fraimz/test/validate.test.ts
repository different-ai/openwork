import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { validate } from "../src/validate.ts";
import type { VisionRequest } from "../src/validate.ts";
import type { Shot } from "../src/screenshot.ts";

function testShot(hash: string): Shot {
  return {
    png: Buffer.from("canned png"),
    hash,
    route: "#/workspace/ws_test/session",
    visibleText: "OpenWork composer",
    at: "2026-07-29T12:00:00.000Z",
  };
}

test("validate describes, matches, computes failure facts, and caches", async () => {
  const unique = randomUUID();
  const expectations = [`Composer is visible ${unique}`, `No error is visible ${unique}`];
  const requests: VisionRequest[] = [];
  const ask = async (request: VisionRequest): Promise<string> => {
    requests.push(request);
    if (requests.length === 1) return JSON.stringify({ description: "A composer and an error banner are visible." });
    return JSON.stringify({
      results: [
        { expectation: expectations[0], passed: true, evidence: "The composer is centered on screen." },
        { expectation: expectations[1], passed: false, evidence: "An error banner is visible." },
      ],
    });
  };

  const first = await validate(testShot(unique), expectations, { ask });
  assert.equal(first.cached, false);
  assert.equal(first.ok, false);
  assert.equal(first.description, "A composer and an error banner are visible.");
  assert.equal(first.results[0]?.passed, true);
  assert.equal(first.results[1]?.passed, false);
  assert.match(first.why, /No error is visible/);
  assert.match(first.why, /An error banner is visible/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.prompt.includes(unique), false, "description request must not know the expectations");
  assert.equal(requests[1]?.prompt.includes(unique), true);

  const second = await validate(testShot(unique), expectations, { ask });
  assert.equal(second.cached, true);
  assert.equal(second.ok, false);
  assert.equal(requests.length, 2, "cache hit must not call the transport");
});

test("validate rejects malformed model verdicts clearly", async () => {
  let calls = 0;
  const ask = async (): Promise<string> => {
    calls += 1;
    return calls === 1 ? JSON.stringify({ description: "A visible app window." }) : "not-json";
  };
  await assert.rejects(
    () => validate(testShot(randomUUID()), [`Visible app ${randomUUID()}`], { ask }),
    /Vision model verdict response was not valid JSON/,
  );
});
