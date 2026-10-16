import assert from "node:assert/strict";
import { test } from "node:test";
import { DaytonaApi, type Sandbox } from "./api.ts";
import { EVIDENCE_KIND } from "./kinds.ts";
import { runScript } from "./builder.ts";
import { failureLayer, localEvidenceReady, parseGuestHealth, requireLocalEvidenceReady, safeExternalResponse } from "./health.ts";
import { launchDaytonaEvidenceWorld, waitForCdp, type DaytonaEvidenceSession } from "./world.ts";

const sha = "a".repeat(40);
const fingerprint = "b".repeat(40);
const sandbox: Sandbox = { id: "owned", name: "owned", state: "started", labels: { kind: EVIDENCE_KIND, sourceSha: sha } };
const cdpBody = JSON.stringify({ Browser: "Chrome/123", webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/browser/private" });
const healthy = { chrome: { status: 200, cdp: true }, gateway: { status: 200, cdp: true }, chromePort: 9999, upstreamPort: 9999,
  listeners: [9999, 8081], units: [{ name: "openwork-evidence", active: "active", sub: "running", result: "success", exit: 0 }],
  journals: [{ name: "openwork-evidence", events: [] }], browserEvents: [], kernelEvents: [], oomKills: 0 };
const session: DaytonaEvidenceSession = { id: "owned", sourceSha: sha, cookie: "__Host-openwork-preview=private-cookie", expiresAt: "later",
  viewer: { url: "https://signed-viewer-private.example", previewToken: "private-preview-token" },
  cdp: { url: "https://signed-cdp-private.example", previewToken: "private-preview-token" } };
function fakeApi(overrides: Partial<DaytonaApi> = {}) {
  return Object.assign(new DaytonaApi({ apiKey: "private-api-key", apiUrl: "https://x.test/api", region: "r" }, async () => { throw new Error("unexpected provider call"); }), {
    waitForSandbox: async () => sandbox,
    readFile: async (_vm: Sandbox, path: string) => path.endsWith("built-from-sha") ? sha : path.endsWith("evidence-ready") ? "web-v1" : fingerprint,
    previewUrl: async () => ({ url: session.cdp.url, token: session.cdp.previewToken }), writeFile: async () => {},
    execChecked: async () => JSON.stringify(healthy), deleteSandbox: async () => {},
    createSshAccess: async () => { throw new Error("no SSH in this fake"); }, ...overrides,
  });
}

test("preparation requires live Chrome and live authenticated gateway, not ready markers", async () => {
  for (const state of [
    { ...healthy, chrome: { status: 0, cdp: false } },
    { ...healthy, gateway: { status: 0, cdp: false } },
    { ...healthy, gateway: { status: 502, cdp: false } },
    { ...healthy, upstreamPort: 8888 },
    { ...healthy, chrome: { status: 200, cdp: false } },
  ]) {
    assert.equal(localEvidenceReady(parseGuestHealth(JSON.stringify(state))), false);
    await assert.rejects(requireLocalEvidenceReady(fakeApi({ execChecked: async () => JSON.stringify(state) }), sandbox, 1, 0), /local readiness failed/);
  }
  await requireLocalEvidenceReady(fakeApi(), sandbox, 1, 0);
});

test("preparation tolerates bounded startup progress and then proves both routes", async () => {
  let calls = 0;
  await requireLocalEvidenceReady(fakeApi({ execChecked: async () => JSON.stringify(++calls === 1 ? { ...healthy, chrome: { status: 0, cdp: false } } : healthy) }), sandbox, 2, 0);
  assert.equal(calls, 2);
});

for (const { label, state, expected } of [
  { label: "dead Chrome", state: { ...healthy, chrome: { status: 0, cdp: false }, kernelEvents: ["oom"] }, expected: "chrome-startup-or-crash" },
  { label: "dead gateway", state: { ...healthy, gateway: { status: 0, cdp: false } }, expected: "guest-gateway-or-stale-port" },
  { label: "stale gateway port", state: { ...healthy, upstreamPort: 8888 }, expected: "guest-gateway-or-stale-port" },
  { label: "healthy internals and external 502", state: healthy, expected: "provider-preview-route" },
]) {
  test(`${label}: sanitized diagnostics precede only owned cleanup`, async () => {
    const events: string[] = [];
    const api = fakeApi({ execChecked: async () => { events.push("inspect"); return JSON.stringify(state); },
      deleteSandbox: async (id) => { assert.equal(id, "owned"); events.push("delete"); } });
    await assert.rejects(launchDaytonaEvidenceWorld({ sandbox, runtimeFingerprint: fingerprint }, sha, api, {
      attempts: 1, pauseMs: 0, probe: async () => new Response("Provider bad gateway", { status: 502 }),
      diagnostic: async (summary) => { assert.equal(JSON.parse(summary).layer, expected); events.push("report"); },
    }), /HTTP 502/);
    assert.deepEqual(events, ["inspect", "report", "delete"]);
  });
}

for (const status of [401, 403]) {
  test(`HTTP ${status} is an access failure, not retried as HTTP 502`, async () => {
    let calls = 0;
    await assert.rejects(waitForCdp(session, { attempts: 5, pauseMs: 0, probe: async () => { calls++; return new Response("private body", { status }); } }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
    assert.equal(failureLayer(parseGuestHealth(JSON.stringify(healthy)), status), "external-access");
  });
}

test("a received auth status survives an unreadable private body", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private body error")); } });
  await assert.rejects(waitForCdp(session, { attempts: 1, probe: async () => new Response(body, { status: 401 }) }), /HTTP 401/);
});

test("diagnostics use the started sandbox's current toolbox route", async () => {
  const started = { ...sandbox, toolboxProxyUrl: "https://current-toolbox.example" };
  const api = fakeApi({ waitForSandbox: async () => started, execChecked: async (vm) => { assert.equal(vm.toolboxProxyUrl, started.toolboxProxyUrl); return JSON.stringify(healthy); } });
  await assert.rejects(launchDaytonaEvidenceWorld({ sandbox, runtimeFingerprint: fingerprint }, sha, api, {
    attempts: 1, probe: async () => new Response("bad gateway", { status: 502 }), diagnostic: async (summary) => { assert.ok(!summary.includes("current-toolbox.example")); },
  }), /HTTP 502/);
});

test("transient external failure followed by a real CDP 200 succeeds", async () => {
  let calls = 0;
  await waitForCdp(session, { attempts: 2, pauseMs: 0, probe: async () => ++calls === 1 ? new Response("bad gateway", { status: 502 }) : new Response(cdpBody) });
  assert.equal(calls, 2);
});

test("a 200 HTML page is not accepted as Chrome readiness; history remains bounded", async () => {
  await assert.rejects(waitForCdp(session, { attempts: 10, pauseMs: 0, probe: async () => new Response("<html>private</html>") }), (error: unknown) => {
    assert.ok(error instanceof Error && "history" in error);
    assert.ok(Array.isArray(error.history)); assert.equal(error.history.length, 8); return true;
  });
});

test("diagnostics discard unknown body, secret headers, raw logs and guest fields", () => {
  const secret = "short-secret";
  const external = safeExternalResponse(502, new Headers({ "set-cookie": secret, location: `https://signed.example/?token=${secret}`,
    "x-daytona-preview-token": secret, authorization: secret, server: secret, "x-request-id": secret, "content-type": "text/plain; charset=utf-8" }),
  `${secret} __Host-openwork-preview=${secret} https://signed.example/?token=${secret}`);
  const guest = parseGuestHealth(JSON.stringify({ ...healthy, access: secret, rawLog: secret,
    units: [{ name: "openwork-evidence", active: secret, environment: secret }],
    journals: [{ name: "openwork-evidence", events: [secret, "oom"], rawLog: secret }], browserEvents: [secret, "crash"] }));
  const summary = JSON.stringify({ external, guest });
  assert.ok(!summary.includes(secret)); assert.ok(!summary.includes("signed.example"));
  assert.deepEqual(guest.browserEvents, ["crash"]); assert.equal(external.body, "[private body omitted]");
  assert.deepEqual(external.headers, { "content-type": "text/plain; charset=utf-8" });
});

for (const failing of ["inspect", "hanging-inspect", "report", "hanging-report", "delete"]) {
  test(`${failing} failure cannot mask the original error or prevent owned cleanup`, async () => {
    const deleted: string[] = [];
    const api = fakeApi({ execChecked: async () => { if (failing === "inspect") throw new Error("private diagnostic error"); if (failing === "hanging-inspect") await new Promise(() => {}); return JSON.stringify(healthy); },
      deleteSandbox: async (id) => { deleted.push(id); if (failing === "delete") throw new Error("cleanup failed"); } });
    await assert.rejects(launchDaytonaEvidenceWorld({ sandbox, runtimeFingerprint: fingerprint }, sha, api, {
      attempts: 1, probe: async () => new Response("private body", { status: 502 }), diagnosticTimeoutMs: 5,
      diagnostic: async () => { if (failing === "report") throw new Error("sink failed"); if (failing === "hanging-report") await new Promise(() => {}); },
    }), /HTTP 502/);
    assert.deepEqual(deleted, ["owned"]);
  });
}

test("external facts reach stderr before a stalled toolbox or diagnostic sink can discard them", async () => {
  for (const stalled of ["toolbox", "sink"]) {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => { lines.push(String(line)); };
    let deleted = false;
    try {
      const api = fakeApi({ execChecked: async () => { assert.ok(lines.length > 0); if (stalled === "toolbox") await new Promise(() => {}); return JSON.stringify(healthy); },
        deleteSandbox: async () => { deleted = true; } });
      await assert.rejects(launchDaytonaEvidenceWorld({ sandbox, runtimeFingerprint: fingerprint }, sha, api, {
        attempts: 1, diagnosticTimeoutMs: 5, probe: async () => new Response("private body", { status: 502 }),
        diagnostic: async () => { await new Promise(() => {}); },
      }), /HTTP 502/);
      assert.equal(deleted, true);
      const external = JSON.parse(lines[0] ?? "null");
      assert.equal(external.stage, "daytona-evidence-external"); assert.equal(external.sourceSha, sha);
      assert.equal(external.external[0].status, 502); assert.equal(external.external[0].body, "[private body omitted]");
      assert.ok(!lines.join("\n").includes("private-cookie")); assert.ok(!lines.join("\n").includes("private-preview-token"));
    } finally { console.error = original; }
  }
});

test("a broken stderr sink cannot replace the original failure or prevent deletion", async () => {
  const original = console.error;
  let deleted = false;
  console.error = () => { throw new Error("stderr sink failed"); };
  try {
    const api = fakeApi({ deleteSandbox: async () => { deleted = true; } });
    await assert.rejects(launchDaytonaEvidenceWorld({ sandbox, runtimeFingerprint: fingerprint }, sha, api, {
      attempts: 1, probe: async () => new Response("private body", { status: 502 }),
    }), /HTTP 502/);
    assert.equal(deleted, true);
  } finally { console.error = original; }
});

test("missing guest observations do not implicate Chrome, gateway, or provider", () => {
  for (const data of [{}, { ...healthy, chrome: {} }, { ...healthy, gateway: {} },
    { ...healthy, chromePort: 0 }, { ...healthy, upstreamPort: 0 }]) {
    assert.equal(failureLayer(parseGuestHealth(JSON.stringify(data)), 502), "unresolved");
  }
});

test("valid-looking trace IDs cannot echo the API key, preview token or access cookie", async () => {
  const key = "12345678-1234-1234-1234-123456789abc";
  const preview = "abcdefab-abcd-abcd-abcd-abcdefabcdef";
  const cookie = "0123456789abcdef0123456789abcdef";
  const api = fakeApi({ previewUrl: async () => ({ url: session.cdp.url, token: preview }) });
  api.config.apiKey = key;
  await assert.rejects(launchDaytonaEvidenceWorld({ sandbox, runtimeFingerprint: fingerprint }, sha, api, {
    attempts: 1, probe: async () => new Response("private body", { status: 502, headers: { "x-request-id": key, "cf-ray": preview } }),
    diagnostic: async (summary) => { assert.ok(!summary.includes(key)); assert.ok(!summary.includes(preview)); },
  }), /HTTP 502/);
  const result = safeExternalResponse(502, new Headers({ "x-request-id": cookie }), "private body", [cookie]);
  assert.deepEqual(result.headers, {});
});

test("a guest upstream 502 is not blamed on the provider if internal probes subsequently recover", async () => {
  await assert.rejects(launchDaytonaEvidenceWorld({ sandbox, runtimeFingerprint: fingerprint }, sha, fakeApi(), {
    attempts: 1, probe: async () => new Response("Sandbox unavailable. Launch a fresh sandbox from the review.", { status: 502 }),
    diagnostic: async (summary) => { const data = JSON.parse(summary); assert.equal(data.health.chrome.status, 200); assert.equal(data.health.gateway.status, 200); assert.equal(data.layer, "guest-upstream-at-external-probe"); },
  }), /HTTP 502/);
});

test("source validation failures without an external probe do not imply routing failure", async () => {
  const api = fakeApi({ readFile: async () => "mismatched-source" });
  await assert.rejects(launchDaytonaEvidenceWorld({ sandbox, runtimeFingerprint: fingerprint }, sha, api, {
    diagnostic: async (summary) => { const data = JSON.parse(summary); assert.deepEqual(data.external, []); assert.equal(data.layer, "unresolved"); },
  }), /Prepared world source mismatch/);
});

test("provider correlation retains only safe owned resource identifiers", async () => {
  const id = "87654321-4321-4321-4321-cba987654321";
  const parent = `ow-dy-evidence-image-v1-${"c".repeat(40)}`;
  const vm = { ...sandbox, id, snapshot: parent };
  const api = fakeApi({ waitForSandbox: async () => vm });
  await assert.rejects(launchDaytonaEvidenceWorld({ sandbox: vm, runtimeFingerprint: fingerprint }, sha, api, {
    attempts: 1, probe: async () => new Response("bad gateway", { status: 502 }),
    diagnostic: async (summary) => { const data = JSON.parse(summary); assert.equal(data.sandboxId, id); assert.equal(data.parentSnapshot, parent); },
  }), /HTTP 502/);
  api.config.apiKey = id;
  await assert.rejects(launchDaytonaEvidenceWorld({ sandbox: vm, runtimeFingerprint: fingerprint }, sha, api, {
    attempts: 1, probe: async () => new Response("bad gateway", { status: 502 }),
    diagnostic: async (summary) => { assert.ok(!summary.includes(id)); },
  }), /HTTP 502/);
});

test("builder diagnostics classify bounded private tails without printing their contents", async () => {
  const api = fakeApi({ exec: async (_vm, command) => ({ exitCode: 0, output: command.startsWith("if test") ? "failed" : "fixture-secret https://signed.example/?token=fixture-secret ERR_PNPM_OUTDATED_LOCKFILE ECONNREFUSED" }) });
  let reported = false;
  await assert.rejects(runScript(api, sandbox, "evidence-world", "exit 1", { diagnostic: async (_stage, summary) => {
    reported = true;
    assert.ok(!summary.includes("fixture-secret")); assert.ok(!summary.includes("signed.example"));
    assert.deepEqual(JSON.parse(summary).events, ["dependency", "startup"]);
  } }), /Daytona evidence-world failed/);
  assert.equal(reported, true);
  await assert.rejects(runScript(api, sandbox, "evidence-world", "exit 1", { diagnostic: async () => { throw new Error("sink failed"); } }), /Daytona evidence-world failed/);
});

test("unrelated or changed ownership is neither inspected nor deleted", async () => {
  const api = fakeApi({ waitForSandbox: async () => ({ ...sandbox, labels: { kind: "unrelated" } }),
    execChecked: async () => { assert.fail("must not inspect unrelated VM"); }, deleteSandbox: async () => { assert.fail("must not delete unrelated VM"); } });
  await assert.rejects(launchDaytonaEvidenceWorld({ sandbox, runtimeFingerprint: fingerprint }, sha, api), /unrelated prepared world/);
  await assert.rejects(launchDaytonaEvidenceWorld({ sandbox: { ...sandbox, labels: {} }, runtimeFingerprint: fingerprint }, sha, api), /unrelated prepared world/);
});

test("run 38970708595: preview proxy 502s for the whole window, the SSH gateway still connects", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { createServer } = await import("node:http");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  // Stands in for the in-VM gateway on :8081: CDP only with this world's cookie.
  let cookie = "";
  const gateway = createServer((req, res) => {
    if (req.headers.cookie !== cookie) { res.writeHead(401).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(cdpBody);
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  assert.ok(address && typeof address === "object");
  // Stands in for Daytona's SSH gateway: forwards -L to the gateway above.
  const dir = await mkdtemp(join(tmpdir(), "fake-daytona-ssh-"));
  await writeFile(join(dir, "ssh.mjs"), `import net from "node:net";
const args = process.argv.slice(2);
const local = Number(args[args.indexOf("-L") + 1].split(":")[1]);
net.createServer((socket) => { const up = net.connect(${address.port}, "127.0.0.1"); socket.pipe(up).pipe(socket); up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy()); }).listen(local, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));`);
  const revoked: string[] = [];
  const api = fakeApi({
    writeFile: async (_vm, _path, content) => { cookie = `__Host-openwork-preview=${JSON.parse(content).token}`; },
    createSshAccess: async () => ({ token: "ssh-token", host: "ssh.example.test", port: 22 }),
    revokeSshAccess: async (_id, token) => { revoked.push(token); },
    deleteSandbox: async () => { assert.fail("a reachable world must not be deleted"); },
  });
  try {
    const session = await launchDaytonaEvidenceWorld({ sandbox, runtimeFingerprint: fingerprint }, sha, api, {
      pauseMs: 10, probe: async () => new Response('{"message":"bad gateway"}', { status: 502 }), ssh: { command: [process.execPath, join(dir, "ssh.mjs")] },
    });
    assert.equal(session.browser.route.label, "daytona-ssh");
    assert.match(await (await fetch(`${session.browser.url}/json/version`)).text(), /Chrome\/123/);
    await session.browser.close();
    assert.deepEqual(revoked, ["ssh-token"]);
  } finally { gateway.closeAllConnections(); gateway.close(); }
});
