import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxFeatureDenOrigin } from "../electron/runtime.mjs";

test("sandbox feature discovery uses the configured trusted API origin", () => {
  assert.equal(sandboxFeatureDenOrigin("https://den.example.test"), "https://den.example.test");
  assert.equal(sandboxFeatureDenOrigin("http://127.0.0.1:41234"), "http://127.0.0.1:41234");
  assert.equal(sandboxFeatureDenOrigin("http://[::1]:41234/"), "http://[::1]:41234");
});

test("a feature origin cannot introduce credentials, paths, queries or insecure remote traffic", () => {
  for (const input of [undefined, null, {}, "", "not a URL", "http://den.example.test", "https://user:secret@den.example.test", "https://den.example.test/api/den", "https://den.example.test?value=1", "https://den.example.test#fragment", "file:///tmp/feature.json"]) {
    assert.equal(sandboxFeatureDenOrigin(input), undefined);
  }
});
