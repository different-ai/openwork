// Private values used outside a web page: what counts as a use a card can show, and that what comes back never holds a value.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { requestWithValues, runWithValues, scrubValues, useTarget, validValueUse, valueDestination } from "./value-use.mjs";

const NODE = process.execPath;
const node = (script) => [NODE, "-e", script];
// Made up for the test.
const TOKEN = "made-up-token/+ &42";
const KEY = "another made-up key";
const op = ["op", "read", "op://Private/Example/token"];

test("a use names one to six values with a source each, and either one program to run or one https request", () => {
  const good = [
    { values: [{ name: "GH_TOKEN", command: op }], run: { command: ["gh", "api", "user"] } },
    { values: [{ name: "GH_TOKEN", ask: "GitHub token", as: "file" }], run: { command: ["/usr/bin/env"] } },
    { values: [{ name: "BW_ITEM", command: ["bw", "get", "password", "x"], unlock: { env: "BW_SESSION", ask: "Bitwarden session key" } }], run: { command: ["deploy"] } },
    { values: [{ name: "TOKEN", command: op }], request: { method: "GET", url: "https://api.example.com/user", headers: { Authorization: "Bearer {{TOKEN}}" } } },
    { values: [{ name: "USER", ask: "User" }, { name: "PASS", ask: "Password" }], request: { method: "POST", url: "https://example.com/login", body: "{\"u\":\"{{USER}}\",\"p\":\"{{PASS}}\"}" } },
    { values: Array.from({ length: 6 }, (_, index) => ({ name: `V${index}`, ask: "x" })), run: { command: ["x"] } },
  ];
  for (const use of good) assert.equal(validValueUse(use), true, JSON.stringify(use));
  const bad = [
    undefined, null, {}, { values: [], run: { command: ["x"] } },
    { values: [{ name: "A", ask: "x" }] },
    { values: [{ name: "A", ask: "x" }], run: { command: ["x"] }, request: { method: "GET", url: "https://e.com", headers: { A: "{{A}}" } } },
    { values: Array.from({ length: 7 }, (_, index) => ({ name: `V${index}`, ask: "x" })), run: { command: ["x"] } },
    { values: [{ name: "a", ask: "x" }], run: { command: ["x"] } },
    { values: [{ name: "A", ask: "x" }, { name: "A", ask: "y" }], run: { command: ["x"] } },
    { values: [{ name: "A", ask: "x", command: ["y"] }], run: { command: ["x"] } },
    { values: [{ name: "A" }], run: { command: ["x"] } },
    { values: [{ name: "A", ask: "x", unlock: { env: "K", ask: "k" } }], run: { command: ["x"] } },
    { values: [{ name: "A", ask: "x", as: "pipe" }], run: { command: ["x"] } },
    { values: [{ name: "A", ask: "x", value: "given" }], run: { command: ["x"] } },
    ...["PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].map((name) => ({ values: [{ name, ask: "x" }], run: { command: ["x"] } })),
    { values: [{ name: "A", ask: "x" }], run: { command: ["./relative"] } },
    { values: [{ name: "A", ask: "x" }], run: { command: ["x"], cwd: "/" } },
    { values: [{ name: "A", ask: "x" }], request: { method: "GET", url: "http://e.com", headers: { H: "{{A}}" } } },
    { values: [{ name: "A", ask: "x" }], request: { method: "GET", url: "https://u:p@e.com", headers: { H: "{{A}}" } } },
    { values: [{ name: "A", ask: "x" }], request: { method: "GET", url: "https://e.com/{{A}}" } },
    { values: [{ name: "A", ask: "x" }], request: { method: "TRACE", url: "https://e.com", headers: { H: "{{A}}" } } },
    { values: [{ name: "A", ask: "x" }], request: { method: "GET", url: "https://e.com", headers: { H: "no place" } } },
    { values: [{ name: "A", ask: "x" }], request: { method: "GET", url: "https://e.com", headers: { H: "{{A}} {{B}}" } } },
    { values: [{ name: "A", ask: "x" }], request: { method: "GET", url: "https://e.com", headers: { "Bad Header": "{{A}}" } } },
    { values: [{ name: "A", ask: "x" }], request: { method: "GET", url: "https://e.com", headers: { H: "{{A}}\r\nX: y" } } },
    { values: [{ name: "A", ask: "x", as: "file" }], request: { method: "GET", url: "https://e.com", headers: { H: "{{A}}" } } },
  ];
  for (const use of bad) assert.equal(validValueUse(use), false, JSON.stringify(use));
});

test("the card and the audit log name where each value goes and what it goes to, never the value", () => {
  const run = { values: [{ name: "GH_TOKEN", command: op }, { name: "KEY", ask: "Key", as: "file" }], run: { command: ["gh", "api", "user"] } };
  assert.equal(valueDestination(run, run.values[0]), "$GH_TOKEN");
  assert.equal(valueDestination(run, run.values[1]), "file in $KEY");
  assert.deepEqual(useTarget(run), { kind: "run", command: ["gh", "api", "user"] });
  const request = { values: [{ name: "T", ask: "Token" }, { name: "P", ask: "Password" }], request: { method: "POST", url: "https://api.example.com/v1/login?next=/x", headers: { Authorization: "Bearer {{T}}" }, body: "{{P}}" } };
  assert.equal(valueDestination(request, request.values[0]), "header Authorization");
  assert.equal(valueDestination(request, request.values[1]), "request body");
  assert.deepEqual(useTarget(request), { kind: "request", method: "POST", url: "https://api.example.com/v1/login", origin: "https://api.example.com" });
});

test("every value is scrubbed as it is, URL-encoded, inside JSON and in base64", () => {
  const text = `a ${TOKEN} b ${encodeURIComponent(TOKEN)} c ${JSON.stringify({ t: TOKEN })} d ${Buffer.from(TOKEN).toString("base64")}`;
  const scrubbed = scrubValues(text, [TOKEN]);
  assert.equal(scrubbed.includes(TOKEN), false);
  assert.equal(scrubbed.includes(encodeURIComponent(TOKEN)), false);
  assert.equal(scrubbed.includes(Buffer.from(TOKEN).toString("base64").replace(/=+$/, "")), false);
  assert.match(scrubbed, /^a \[secret\] b \[secret\] c \{"t":"\[secret\]"\} d \[secret\]/);
});

test("a run gets each value in its environment or in a private file, and prints nothing that holds one", async () => {
  const result = await runWithValues({ command: node("const fs=require('fs');console.log(process.env.GH_TOKEN);console.log(fs.readFileSync(process.env.KEY,'utf8'));console.log((fs.statSync(process.env.KEY).mode&0o777).toString(8));console.error('err '+process.env.GH_TOKEN);console.log(process.env.KEY)") },
    [{ name: "GH_TOKEN", value: TOKEN }, { name: "KEY", as: "file", value: KEY }]);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  const [envLine, fileLine, mode, file] = result.output.trim().split("\n");
  assert.equal(envLine, "[secret]");
  assert.equal(fileLine, "[secret]");
  assert.equal(mode, "600");
  assert.equal(result.errors.trim(), "err [secret]");
  assert.equal(existsSync(file), false, "the file is removed once the run ends");
});

test("a run that fails says so with its exit code, and one that cannot start or runs too long says why", async () => {
  const failed = await runWithValues({ command: node(`console.error(process.env.T); process.exit(3)`) }, [{ name: "T", value: TOKEN }]);
  assert.deepEqual(failed.ok && { exitCode: failed.exitCode, errors: failed.errors.trim() }, { exitCode: 3, errors: "[secret]" });
  assert.deepEqual(await runWithValues({ command: ["openwork-no-such-program-for-test"] }, [{ name: "T", value: TOKEN }]), { ok: false, code: "command_not_found" });
  assert.deepEqual(await runWithValues({ command: node("setTimeout(() => {}, 10000)") }, [{ name: "T", value: TOKEN }], { timeoutMs: 200 }), { ok: false, code: "command_timeout" });
  const controller = new AbortController();
  const canceled = runWithValues({ command: node("setTimeout(() => {}, 10000)") }, [{ name: "T", value: TOKEN }], { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await canceled, { ok: false, code: "canceled" });
});

test("a request carries each value at its place, follows no redirect, and returns nothing that holds one", async () => {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const sent = [];
  const fake = async (url, init) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({ echoed: init.headers.Authorization, body: init.body }), { status: 201, headers: { "content-type": "application/json", "set-cookie": `s=${TOKEN}`, location: `https://e.com/?t=${encodeURIComponent(TOKEN)}` } });
  };
  const result = await requestWithValues({ method: "POST", url: "https://api.example.com/login", headers: { Authorization: "Bearer {{T}}" }, body: "{\"p\":\"{{P}}\"}" },
    [{ name: "T", value: TOKEN }, { name: "P", value: KEY }], { fetch: fake });
  assert.equal(sent[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(sent[0].init.body, `{"p":"${KEY}"}`);
  assert.equal(sent[0].init.redirect, "manual");
  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.deepEqual(Object.keys(result.headers).sort(), ["content-type", "location"]);
  assert.equal(result.headers.location, "https://e.com/?t=[secret]");
  assert.equal(JSON.stringify(result).includes(TOKEN) || JSON.stringify(result).includes(KEY), false);
  assert.deepEqual(await requestWithValues({ method: "GET", url: "https://e.com", headers: { H: "{{T}}" } }, [{ name: "T", value: TOKEN }], { fetch: async () => { throw new TypeError("fetch failed"); } }), { ok: false, code: "request_failed" });
});
