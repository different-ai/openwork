import assert from "node:assert/strict";
import { test } from "node:test";
import { inheritedEngineEnv } from "../src/managed-opencode-v2.js";

test("the engine gets the machine's proxy settings and keeps loopback direct", () => {
  const env = inheritedEngineEnv(undefined, {
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://proxy.example.test:8080",
    http_proxy: "http://proxy.example.test:8080",
    NO_PROXY: "internal.example.test, 127.0.0.1",
    DEN_API_TOKEN: "private",
  }, "linux");

  assert.equal(env.HTTPS_PROXY, "http://proxy.example.test:8080");
  assert.equal(env.http_proxy, "http://proxy.example.test:8080");
  assert.equal(env.NO_PROXY, "internal.example.test,127.0.0.1,localhost,::1");
  assert.equal(env.no_proxy, env.NO_PROXY);
  assert.equal(env.DEN_API_TOKEN, undefined);
});

test("a proxy with no exclusions still keeps loopback direct", () => {
  const env = inheritedEngineEnv({ HTTPS_PROXY: "http://proxy.example.test:8080" }, {}, "linux");
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
});

test("an exclude-everything setting is kept as written", () => {
  const env = inheritedEngineEnv({ ALL_PROXY: "socks5://proxy.example.test:1080", NO_PROXY: "*" }, {}, "linux");
  assert.equal(env.NO_PROXY, "*");
});

test("no proxy settings are added when the machine has none", () => {
  const env = inheritedEngineEnv(undefined, { PATH: "/usr/bin" }, "linux");
  assert.deepEqual(Object.keys(env), ["PATH"]);
});

test("Windows passes each proxy setting once, whatever its spelling", () => {
  const env = inheritedEngineEnv(undefined, { Https_Proxy: "http://proxy.example.test:8080", No_Proxy: "internal.example.test" }, "win32");
  const names = Object.keys(env).map((name) => name.toUpperCase());
  assert.deepEqual(names.sort(), ["HTTPS_PROXY", "NO_PROXY"]);
  assert.equal(Object.values(env).find((value) => value.includes("internal")), "internal.example.test,localhost,127.0.0.1,::1");
});
