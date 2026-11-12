import assert from "node:assert/strict";
import test from "node:test";
import { downloadWithRetry } from "../scripts/download-with-retry.mjs";

const ok = { status: 0, stdout: "", stderr: "" };
const fail = stderr => ({ status: 22, stdout: "", stderr });

test("download retries only curl transport failures with fixed time/attempt bounds", async () => {
  const calls = [];
  const delays = [];
  const results = [fail("curl: (28) Operation timed out"), fail("curl: (22) The requested URL returned error: 503"), ok];
  await downloadWithRetry("https://example.com/archive.tgz", "/output/archive.tgz", {
    spawn: (command, args) => { calls.push({ command, args }); return results.shift(); },
    sleep: async delay => { delays.push(delay); }, log() {},
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [1000, 2000]);
  for (const { command, args } of calls) {
    assert.match(command, /^curl(?:\.exe)?$/);
    assert.equal(args[0], "--disable");
    assert.equal(args[args.indexOf("--retry") + 1], "0");
    assert.equal(args[args.indexOf("--max-time") + 1], "300");
    assert.equal(args[args.indexOf("--connect-timeout") + 1], "20");
    assert.ok(!args.includes("--retry-all-errors"));
    assert.equal(args.at(-1), "https://example.com/archive.tgz");
    assert.equal(args[args.indexOf("--output") + 1], "/output/archive.tgz");
  }
});
for (const message of ["curl: (22) The requested URL returned error: 404", "curl: (60) SSL certificate problem", "curl: (23) Failed writing body"]) {
  test(`download does not retry deterministic failure: ${message}`, async () => {
    let calls = 0;
    await assert.rejects(downloadWithRetry("https://example.com/missing", "/output/archive", {
      spawn: () => { calls++; return fail(message); },
      sleep: () => assert.fail("must not retry"), log() {},
    }), /curl:/);
    assert.equal(calls, 1);
  });
}
test("download stops after three unsuccessful transport attempts", async () => {
  let calls = 0;
  await assert.rejects(downloadWithRetry("https://example.com/archive", "/output/archive", {
    spawn: () => { calls++; return fail("curl: (56) Recv failure: Connection reset by peer"); },
    sleep: async () => {}, log() {},
  }), /curl: \(56\)/);
  assert.equal(calls, 3);
});
