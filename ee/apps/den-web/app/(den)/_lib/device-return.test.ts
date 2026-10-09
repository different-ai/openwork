import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceReturnTarget, deviceReturnUrl } from "./device-return";

test("only the OpenCode plugin may return the browser, and only to its own loopback page", () => {
  const plugin = "openwork-opencode-plugin";
  assert.equal(deviceReturnUrl("http://127.0.0.1:53121/openwork/callback", plugin)?.toString(), "http://127.0.0.1:53121/openwork/callback");

  assert.equal(deviceReturnUrl("http://127.0.0.1:53121/openwork/callback", "openwork-cli"), null, "other clients never redirect");
  assert.equal(deviceReturnUrl("http://127.0.0.1:53121/openwork/callback", null), null);
  assert.equal(deviceReturnUrl("http://127.0.0.1:8080/admin/delete", plugin), null, "no other path on the machine");
  assert.equal(deviceReturnUrl("http://127.0.0.1:53121/openwork/callback?x=1", plugin), null, "no extra query");
  assert.equal(deviceReturnUrl("http://localhost:53121/openwork/callback", plugin), null, "only the address the plugin uses");
  assert.equal(deviceReturnUrl("http://[::1]:53121/openwork/callback", plugin), null);
  assert.equal(deviceReturnUrl("https://evil.example/openwork/callback", plugin), null);
  assert.equal(deviceReturnUrl("http://127.0.0.1.evil.example:80/openwork/callback", plugin), null);
  assert.equal(deviceReturnUrl("https://127.0.0.1:9/openwork/callback", plugin), null, "loopback pages are plain http");
  assert.equal(deviceReturnUrl("http://127.0.0.1/openwork/callback", plugin), null, "an explicit port is required");
  assert.equal(deviceReturnUrl("http://user:pass@127.0.0.1:9/openwork/callback", plugin), null);
  assert.equal(deviceReturnUrl("http://127.0.0.1:9/openwork/callback#x", plugin), null);
  assert.equal(deviceReturnUrl("javascript:alert(1)", plugin), null);
  assert.equal(deviceReturnUrl("", plugin), null);
  assert.equal(deviceReturnUrl(null, plugin), null);
});

test("the return target carries only the outcome", () => {
  const url = deviceReturnUrl("http://127.0.0.1:9/openwork/callback", "openwork-opencode-plugin")!;
  assert.equal(deviceReturnTarget(url, "approved"), "http://127.0.0.1:9/openwork/callback?result=approved");
  assert.equal(deviceReturnTarget(url, "denied"), "http://127.0.0.1:9/openwork/callback?result=denied");
});
