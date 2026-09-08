import assert from "node:assert/strict";
import test from "node:test";
import { textProgressFailures } from "../src/text-observation.ts";

test("streaming proof permits loading before output and repeated frames", () => {
  assert.deepEqual(textProgressFailures(["", "", "Hello", "Hello", "Hello world"], "Hello world"), []);
});
test("streaming proof rejects blank, shrinking, substituted, duplicate, and incomplete output", () => {
  for (const samples of [
    ["Hello", "", "Hello world"], ["Hello wor", "Hello", "Hello world"],
    ["Other answer", "Hello world"], ["Hello world\nHello world"], [""], [], ["Hello"],
  ]) assert.ok(textProgressFailures(samples, "Hello world").length > 0, JSON.stringify(samples));
});

import { runInNewContext } from "node:vm";
import type { Surface } from "@openwork/cdp";
import { observeText } from "../src/text-observation.ts";

test("the browser observer retains an empty frame between visible text frames", async () => {
  let text = "";
  let frame: (() => void) | undefined;
  const page = {
    window: {},
    document: { querySelectorAll: () => text ? [{ innerText: text, getClientRects: () => [{}], closest: () => null }] : [] },
    getComputedStyle: () => ({ visibility: "visible" }),
    requestAnimationFrame: (callback: () => void) => { frame = callback; return 1; },
    cancelAnimationFrame: () => {}, setTimeout: () => 1, clearTimeout: () => {},
  };
  const surface: Surface = {
    handle: { name: "text", kind: "electron", hostKind: "test", cdpUrl: "http://127.0.0.1:1" },
    client: {
      async send(method, params = {}) {
        if (method === "Runtime.evaluate") return { result: { objectId: "page" } };
        if (typeof params.functionDeclaration !== "string" || !Array.isArray(params.arguments)) throw new Error("Unexpected CDP invocation");
        const fn: unknown = runInNewContext(`(${params.functionDeclaration})`, page);
        if (typeof fn !== "function") throw new Error("Browser evaluation was not a function");
        const args = params.arguments.map((arg: unknown) => arg && typeof arg === "object" && "value" in arg ? arg.value : undefined);
        return { result: { value: fn(...args) } };
      }, close() {},
    },
  };
  await using observation = await observeText(surface, '[data-message-role="assistant"]');
  for (const value of ["Hello", "", "Hello world"]) { text = value; frame?.(); }
  const samples = await observation.finish();
  assert.equal(JSON.stringify(samples), JSON.stringify(["", "Hello", "", "Hello world"]));
  assert.ok(textProgressFailures(samples, "Hello world").length > 0);
});
