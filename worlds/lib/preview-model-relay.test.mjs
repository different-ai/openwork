import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createModelRelay } from "./preview-model-relay.mjs";

test("only the selected model reaches the gateway and upstream credentials stay private", async (t) => {
  const key = "synthetic-relay-secret";
  const model = "openai/example";
  let calls = 0;
  const relay = createModelRelay({ key, model }, async (url, init) => {
    calls++;
    assert.equal(url.href, "https://ai-gateway.vercel.sh/v1/responses");
    assert.equal(init.headers.authorization, `Bearer ${key}`);
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.cookie, undefined);
    return calls === 1 ? new Response("stream", { headers: { "x-diagnostic": key } })
      : new Response(key, { status: 403 });
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  t.after(() => new Promise(resolve => relay.close(resolve)));
  const origin = `http://127.0.0.1:${relay.address().port}`;
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers, body: JSON.stringify(body) });
  for (const response of [
    await post("/v1/responses", { model: "other" }),
    await post("/unrelated", { model }),
    await post("/v1/responses", { model }, { origin: "https://example.test" }),
  ]) assert.equal(response.status, 403);
  assert.equal(calls, 0);
  const success = await post("/v1/responses", { model }, { cookie: "fixture=true" });
  assert.equal(await success.text(), "stream");
  assert.equal(success.headers.get("x-diagnostic"), null);
  const failure = await post("/v1/responses", { model });
  assert.equal(failure.status, 403);
  assert.equal(await failure.text(), "");
});
