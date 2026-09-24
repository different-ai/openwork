import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { templateHostsEntries } from "../src/builder.ts";
import { guestCommandOutcome, waitForServiceRoutes } from "../src/index.ts";
import { templateOrigins } from "../src/origins.mjs";
import { desktopChatResult, responseErrorCode, responseErrorSource } from "../src/verify-results.ts";

const handshake = () => new Response(null, { status: 303, headers: { "set-cookie": "__Host-openwork-preview=synthetic; Path=/" } });
const origins = { den: "https://den-x.preview.openwork.software", api: "https://api-x.preview.openwork.software" };

test("service routes: every linked hostname must answer the gateway handshake", async () => {
  const seen: string[] = [];
  await waitForServiceRoutes(origins, "t", async (input) => { seen.push(new URL(String(input)).host); return handshake(); }, async () => undefined);
  assert.deepEqual(seen.sort(), ["api-x.preview.openwork.software", "den-x.preview.openwork.software"]);
});

test("service routes: a hostname whose edge route is not live yet is retried until it answers", async () => {
  let apiCalls = 0;
  await waitForServiceRoutes(origins, "t", async (input) => {
    if (new URL(String(input)).host.startsWith("api-") && ++apiCalls < 3) return new Response("bad gateway", { status: 502 });
    return handshake();
  }, async () => undefined);
  assert.equal(apiCalls, 3);
});

test("service routes: a refusal fails at once and a dead route fails at the deadline, naming the service", async () => {
  let calls = 0;
  await assert.rejects(waitForServiceRoutes({ api: origins.api }, "t", async () => { calls++; return new Response("no", { status: 401 }); }, async () => undefined),
    /^Error: Public sandbox readiness failed \(HTTP 401\) for api\.$/);
  assert.equal(calls, 1);
  await assert.rejects(waitForServiceRoutes({ den: origins.den }, "t", async () => new Response("", { status: 502 }), async () => undefined, 0),
    /Public sandbox readiness failed \(HTTP unreachable\) for den\./);
  await assert.rejects(waitForServiceRoutes({ den: origins.den }, "t", async () => new Response("", { status: 502 }), async () => undefined, 30),
    /Public sandbox readiness failed \(HTTP 502\) for den\./);
});

test("failed responses name their source without printing the body", () => {
  const relayed = new Headers({ "referrer-policy": "no-referrer" });
  assert.equal(responseErrorSource(relayed, JSON.stringify({ code: "managed_mcp_connection_failed", message: "private" })), "service error managed_mcp_connection_failed");
  assert.equal(responseErrorSource(relayed, "<html>private</html>"), "service error without a code");
  assert.equal(responseErrorSource(new Headers(), "Sandbox unavailable. Launch a fresh sandbox from the review."), "preview gateway could not reach the service");
  assert.equal(responseErrorSource(new Headers(), "This world is not ready. Try launching again from the review."), "preview gateway has no service map yet");
  assert.equal(responseErrorSource(new Headers(), "<html>edge 502 with details</html>"), "not from the preview gateway (provider edge or network)");
});

test("desktop chat results accept only known steps and finite timings", () => {
  const ok = desktopChatResult(`noise\n${JSON.stringify({ ok: true, step: "done", timings: { import: 800, attach: 1100.4 }, model: "Claude Haiku 4.5", reply: "Acme AI Gateway is working." })}\n`);
  assert.deepEqual(ok, { ok: true, step: "done", timedOut: false, timings: { import: 800, attach: 1100 }, model: "Claude Haiku 4.5", reply: "Acme AI Gateway is working." });
  assert.deepEqual(desktopChatResult(JSON.stringify({ ok: false, step: "send", timedOut: true, timings: {} })), { ok: false, step: "send", timedOut: true, timings: {} });
  for (const invalid of [
    "", "not json", JSON.stringify([]),
    JSON.stringify({ ok: true, step: "Bearer secret", timings: {} }),
    JSON.stringify({ ok: true, step: "done", timings: { "token=abc": 1 } }),
    JSON.stringify({ ok: true, step: "done", timings: { import: "1" } }),
    JSON.stringify({ ok: true, step: "done", timings: { import: -1 } }),
    JSON.stringify({ ok: "yes", step: "done", timings: {} }),
  ]) assert.equal(desktopChatResult(invalid), null, invalid);
  assert.equal(desktopChatResult(null), null);
});

test("response error codes are short identifiers or nothing", () => {
  assert.equal(responseErrorCode({ code: "managed_mcp_connection_failed", message: "private detail" }), "managed_mcp_connection_failed");
  assert.equal(responseErrorCode({ name: "ProviderAuthError", data: { message: "private" } }), "ProviderAuthError");
  assert.equal(responseErrorCode({ code: "has spaces and a Bearer token" }), "");
  assert.equal(responseErrorCode({ code: "x".repeat(65) }), "");
  assert.equal(responseErrorCode("plain text"), "");
  assert.equal(responseErrorCode(undefined), "");
});

test("guest command outcomes tell a timeout from an exit status", () => {
  assert.equal(guestCommandOutcome(null, 180_000), "killed at 180s timeout");
  assert.equal(guestCommandOutcome(undefined, 60_000), "killed at 60s timeout");
  assert.equal(guestCommandOutcome(1, 180_000), "exit 1");
  assert.equal(guestCommandOutcome(0, 180_000), "exit 0");
});

test("every template origin is refused locally over IPv4 and IPv6", () => {
  const lines = templateHostsEntries().trim().split("\n");
  assert.equal(lines.length, 2);
  const hosts = Object.values(templateOrigins).map((origin) => new URL(origin).hostname);
  assert.equal(hosts.length, 6);
  for (const [line, address] of [[lines[0], "127.0.0.1"], [lines[1], "::1"]]) {
    const [first, ...names] = line.split(" ");
    assert.equal(first, address);
    assert.deepEqual(names, hosts);
  }
  for (const host of hosts) assert.match(host, /^[a-z]+-0{32}\.preview\.openwork\.software$/);
});

test("the desktop chat check always prints one result line and exits", async () => {
  const source = await readFile(new URL("../src/desktop-chat-check.mjs", import.meta.url), "utf8");
  // Outside a clone its imports fail at once: it must still report and exit non-zero.
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 1);
  assert.deepEqual(desktopChatResult(run.stdout), { ok: false, step: "import", timedOut: false, timings: {} });
});
