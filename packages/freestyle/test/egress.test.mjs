import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { previewEgress } from "../src/egress.mjs";
import { originReplacements, templateOrigins } from "../src/origins.mjs";

const clone = Object.fromEntries(Object.entries(templateOrigins).map(([name, origin]) => [name, origin.replace("0".repeat(32), "1".repeat(32))]));
const callback = (origins) => `${origins.den}/v1/mcp-connections/oauth/callback`;
const clientId = (origins) => `${origins.den}/oauth/client-metadata.json`;

function recorder() {
  const calls = [];
  const send = async (input, init) => { calls.push({ input, init }); return new Response("{}"); };
  return { calls, send };
}

test("OAuth requests leave a clone with its own origins: registration, token exchange and query strings", async () => {
  const { calls, send } = recorder();
  const fetch = previewEgress(send, async () => originReplacements(templateOrigins, clone));
  await fetch("https://mcp.example/register", {
    method: "POST", headers: { "content-type": "application/json", "content-length": "999" },
    body: JSON.stringify({ redirect_uris: [callback(templateOrigins)] }),
  });
  await fetch(new URL("https://mcp.example/token"), {
    method: "POST", body: new URLSearchParams({ client_id: clientId(templateOrigins), redirect_uri: callback(templateOrigins), code: "code" }),
  });
  await fetch(`https://mcp.example/authorize?redirect_uri=${encodeURIComponent(callback(templateOrigins))}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { redirect_uris: [callback(clone)] });
  assert.equal(calls[0].init.headers.get("content-type"), "application/json");
  assert.equal(calls[0].init.headers.get("content-length"), null);
  assert.ok(calls[1].init.body instanceof URLSearchParams);
  assert.deepEqual(Object.fromEntries(calls[1].init.body), { client_id: clientId(clone), redirect_uri: callback(clone), code: "code" });
  assert.equal(new URL(calls[2].input).searchParams.get("redirect_uri"), callback(clone));
});

test("requests that stay in the VM, name no template origin, or run before a clone exists pass through untouched", async () => {
  const { calls, send } = recorder();
  let reads = 0;
  const pairs = async () => { reads++; return originReplacements(templateOrigins, clone); };
  const fetch = previewEgress(send, pairs);
  const body = JSON.stringify({ redirect_uris: [callback(templateOrigins)] });
  const request = new Request("https://mcp.example/register", { method: "POST", body });
  for (const [input, init] of [
    ["http://127.0.0.1:8790/v1/me", { method: "POST", body }],
    [`${templateOrigins.den}/v1/me`, { method: "POST", body }],
    ["https://mcp.example/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }) }],
    [request, undefined],
  ]) {
    await fetch(input, init);
    assert.equal(calls.at(-1).input, input);
    assert.equal(calls.at(-1).init, init);
  }
  assert.equal(reads, 0);
  const template = previewEgress(send, async () => []);
  const init = { method: "POST", body };
  await template("https://mcp.example/register", init);
  assert.equal(calls.at(-1).init, init);
});

test("Den's preload translates through its access file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-egress-"));
  try {
    const access = join(directory, "access.json");
    const recording = join(directory, "recorder.mjs");
    await writeFile(access, JSON.stringify({ token: "sandbox-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), origins: clone, templateOrigins }));
    await writeFile(recording, "globalThis.fetch = async (input, init) => { globalThis.recorded = { url: String(input), body: init.body }; return new Response('{}'); };\n");
    const egress = new URL("../src/egress.mjs", import.meta.url).href;
    const script = `await fetch("https://mcp.example/register", { method: "POST", body: ${JSON.stringify(JSON.stringify({ redirect_uris: [callback(templateOrigins)] }))} }); console.log(JSON.stringify(globalThis.recorded));`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, OPENWORK_PREVIEW_ACCESS_FILE: access, NODE_OPTIONS: `--import=${pathToFileURL(recording).href} --import=${egress}` },
    });
    const recorded = JSON.parse(stdout);
    assert.equal(recorded.url, "https://mcp.example/register");
    assert.deepEqual(JSON.parse(recorded.body), { redirect_uris: [callback(clone)] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
