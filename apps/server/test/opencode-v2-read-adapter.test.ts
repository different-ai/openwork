import assert from "node:assert/strict";
import { test } from "node:test";
import { createV2ReadAdapter } from "../src/opencode-v2-read-adapter.js";

function message(index: number) {
  return { id: `msg_${index}`, type: index % 2 ? "assistant" : "user", time: { created: index },
    ...(index % 2 ? { content: [{ type: "text", text: `message ${index}` }, { type: "reasoning", text: "private" }] } : { text: `message ${index}` }) };
}
const path = "/workspace/ws_fixture/opencode/session/ses_fixture/message";
function fixture(count: number) {
  const requests: URL[] = [];
  const history = Array.from({ length: count }, (_, index) => message(count - index - 1));
  const read = createV2ReadAdapter(async target => {
    const url = new URL(target, "http://engine");
    requests.push(url);
    assert.equal(url.pathname, "/workspace/ws_fixture/opencode2/api/session/ses_fixture/message");
    const limit = Number(url.searchParams.get("limit"));
    assert.ok(Number.isInteger(limit) && limit > 0 && limit <= 200, `invalid native page limit: ${limit}`);
    const cursor = url.searchParams.get("cursor");
    assert.equal(url.searchParams.get("order"), cursor ? null : "desc");
    const offset = cursor ? Number(cursor.split(":")[1]) : 0;
    const data = history.slice(offset, offset + limit);
    const next = offset + data.length < count ? `opaque:${offset + data.length}` : undefined;
    return { data, cursor: { next } };
  });
  return { read, requests };
}

for (const history of [150, 200, 201, 400, 450]) {
  for (const total of [1, 150, 200, 201, 300, 400, 450, undefined]) {
    test(`history ${history}, total ${total ?? "all"}: newest messages, chronological, bounded native pages`, async () => {
      const { read, requests } = fixture(history);
      const count = Math.min(history, total ?? history);
      assert.deepEqual(await read(path + (total === undefined ? "" : `?limit=${total}`)),
        Array.from({ length: count }, (_, index) => {
          const row = message(history - count + index);
          return { info: { id: row.id, role: row.type, time: row.time }, parts: [{ type: "text", text: `message ${history - count + index}` }] };
        }));
      assert.equal(requests.length, Math.ceil(count / 200));
      if (total !== undefined && total <= history) {
        assert.equal(requests.reduce((sum, url) => sum + Number(url.searchParams.get("limit")), 0), total);
      }
    });
  }
}

for (const limit of ["", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "oops"]) {
  test(`rejects invalid total ${JSON.stringify(limit)} before transport`, async () => {
    let calls = 0;
    const read = createV2ReadAdapter(async () => { calls++; return { data: [] }; });
    await assert.rejects(read(`${path}?limit=${encodeURIComponent(limit)}`), /positive.*integer/i);
    assert.equal(calls, 0);
  });
}

for (const cursors of [["again", "again"], ["one", "two", "one"]]) {
  test(`rejects cyclic cursors ${cursors.join(" -> ")}`, async () => {
    let calls = 0;
    const read = createV2ReadAdapter(async () => ({ data: [message(calls)], cursor: { next: cursors[calls++] } }));
    await assert.rejects(read(`${path}?limit=400`), /pagination cursor/);
    assert.equal(calls, cursors.length);
  });
}

test("a repeated cursor is rejected even when the final page reaches the total", async () => {
  let calls = 0;
  const read = createV2ReadAdapter(async () => ({ data: [message(calls++)], cursor: { next: "again" } }));
  await assert.rejects(read(`${path}?limit=2`), /pagination cursor/);
  assert.equal(calls, 2);
});

test("empty pages terminate even when the engine offers another cursor", async () => {
  let calls = 0;
  const read = createV2ReadAdapter(async () => { calls++; return { data: [], cursor: { next: "empty" } }; });
  assert.deepEqual(await read(`${path}?limit=400`), []);
  assert.equal(calls, 1);
});

test("oversized engine pages never exceed the requested total", async () => {
  let calls = 0;
  const read = createV2ReadAdapter(async () => { calls++; return { data: [message(2), message(1), message(0)], cursor: { next: "ignored" } }; });
  const rows = await read(`${path}?limit=2`);
  assert.deepEqual(rows, [1, 2].map(index => ({ info: { id: `msg_${index}`, role: message(index).type, time: { created: index } }, parts: [{ type: "text", text: `message ${index}` }] })));
  assert.equal(calls, 1);
});

test("equal timestamps retain chronological native order across pages", async () => {
  const batches = [[{ ...message(2), time: { created: 1 } }, message(1)], [{ ...message(0), time: { created: 1 } }]];
  let calls = 0;
  const read = createV2ReadAdapter(async () => ({ data: batches[calls], cursor: { next: calls++ === 0 ? "older" : undefined } }));
  const result = await read(`${path}?limit=3`);
  assert.deepEqual(result, [0, 1, 2].map(index => ({ info: { id: `msg_${index}`, role: message(index).type, time: { created: 1 } }, parts: [{ type: "text", text: `message ${index}` }] })));
});

test("later transport errors propagate rather than returning a truncated success", async () => {
  let calls = 0;
  const read = createV2ReadAdapter(async () => {
    if (calls++) throw new Error("upstream unavailable");
    return { data: [message(1)], cursor: { next: "older" } };
  });
  await assert.rejects(read(`${path}?limit=400`), /upstream unavailable/);
});

test("unlimited session listing still follows native cursors", async () => {
  let calls = 0;
  const read = createV2ReadAdapter(async target => {
    const url = new URL(target, "http://engine");
    assert.equal(url.searchParams.get("limit"), "200");
    assert.equal(url.searchParams.get("cursor"), calls === 0 ? null : "more");
    return { data: [{ id: `ses_${calls}`, location: { directory: "/fixture" } }], cursor: { next: calls++ === 0 ? "more" : undefined } };
  });
  assert.deepEqual(await read("/workspace/ws_fixture/opencode/session"), [0, 1].map(index => ({ id: `ses_${index}`, location: { directory: "/fixture" }, directory: "/fixture" })));
});
