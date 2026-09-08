import ts from "typescript";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBrowserCode } from "./check-browser-code.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { compareBaseline, countRawEscapes } from "./spec-channel-ratchet.mjs";

test("countRawEscapes counts raw rails only when their exact syntax is present", () => {
  const source = `
    import { evalIn } from "@openwork/behaviors";
    evalIn(app, "read");
    denFetch(den, "/v1/write");
    browser.client.send("Input.insertText");
    localStorage.setItem("key", "value");
    seed.evalIn(app, "write");
    probe.eval("read");
  `;
  assert.equal(countRawEscapes(source), 6);
  assert.equal(countRawEscapes("const evalIn = () => true; evalIn();"), 0);
});

test("compareBaseline rejects increases and stale entries", () => {
  const newLayerFiles = new Set();
  assert.deepEqual(compareBaseline({ "kept.e2e.test.ts": 3 }, { "kept.e2e.test.ts": 2 }, new Set(["kept.e2e.test.ts"]), newLayerFiles).errors, [
    "kept.e2e.test.ts: raw channel escapes increased 2 → 3",
  ]);
  assert.deepEqual(compareBaseline({ "kept.e2e.test.ts": 1 }, { "kept.e2e.test.ts": 2 }, new Set(["kept.e2e.test.ts"]), newLayerFiles).errors, [
    "kept.e2e.test.ts: baseline is stale 2 → 1; lower it",
  ]);
  assert.deepEqual(compareBaseline({}, { "gone.e2e.test.ts": 1 }, new Set(), newLayerFiles).errors, [
    "gone.e2e.test.ts: baseline is stale; file no longer exists",
  ]);
});

test("compareBaseline warns for unbaselined legacy specs without failing", () => {
  assert.deepEqual(compareBaseline({ "legacy.e2e.test.ts": 2 }, {}, new Set(["legacy.e2e.test.ts"]), new Set()), {
    errors: [],
    warnings: ["unbaselined legacy spec: legacy.e2e.test.ts (2 escapes) — add to baseline when migrating"],
  });
});

test("compareBaseline rejects raw escapes in an unbaselined new-layer spec", () => {
  assert.deepEqual(
    compareBaseline(
      { "layered.e2e.test.ts": 2 },
      {},
      new Set(["layered.e2e.test.ts"]),
      new Set(["layered.e2e.test.ts"]),
    ),
    {
      errors: ["layered.e2e.test.ts: new-layer spec has 2 raw channel escapes; expected 0"],
      warnings: [],
    },
  );
});


test("browser boundary rejects raw strings, imported aliases, captures and mismatched arguments", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const fixture = resolve(root, "evals/browser-guard-fixture.ts");
  const source = `
    import { browserScript as script } from "./packages/cdp/src/browser-script.ts";
    import { evaluate as run } from "./packages/cdp/src/cdp.ts";
    import type { CdpClient } from "./packages/cdp/src/cdp.ts";
    declare const client: CdpClient;
    const secret = "test-process-only";
    run(client, "document.title");
    run(client, () => secret);
    run(client, () => ({ secret }));
    run(client, () => process.pid);
    run(client, () => document.body);
    run(client, () => () => 1);
    script((value) => Boolean(value), [new Date()]);
    script((value: number) => value + 1, ["wrong"]);
    script((title) => document.title === title, ["safe"]);
  `;
  const options = { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  host.readFile = path => path === fixture ? source : read(path);
  const program = ts.createProgram([fixture], options, host);
  const result = checkBrowserCode(program, root, path => path === fixture);
  assert.ok(result.failures.some(message => message.includes("Raw browser code")));
  assert.equal(result.failures.filter(message => message.includes("captures 'secret'")).length, 2);
  assert.ok(result.failures.some(message => message.includes("captures 'process'")));
  assert.ok(result.failures.some(message => message.includes("not assignable to type 'number'")));
  assert.equal(result.failures.filter(message => message.includes("Browser result contains")).length, 2);
  assert.ok(result.failures.some(message => message.includes("Browser arguments contain")));
  assert.ok(!result.failures.some(message => message.includes("captures 'document'")));
});
