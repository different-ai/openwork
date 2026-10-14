import assert from "node:assert/strict";
import { test } from "node:test";
import { DaytonaApi, type Sandbox } from "./api.ts";
import { ensureLayer, prepareWorldLayer } from "./builder.ts";
import { EVIDENCE_KIND } from "./kinds.ts";
import { launchDaytonaEvidenceWorld } from "./world.ts";

const sha = "a".repeat(40);
const fingerprint = "b".repeat(40);
const sandbox: Sandbox = { id: "owned", name: "owned", state: "started", labels: { kind: EVIDENCE_KIND, sourceSha: sha } };

function fakeApi(overrides: Partial<DaytonaApi> = {}) {
  return Object.assign(new DaytonaApi({ apiKey: "k", apiUrl: "https://x.test/api", region: "r" }, async () => {
    throw new Error("unexpected provider call");
  }), overrides);
}

function layer(events: string[]) {
  return { name: "template", stage: "daytona-world", withMemory: true,
    parent: async () => { events.push("parent"); return "warm-image"; },
    prepare: async (vm: Sandbox) => { assert.equal(vm.id, sandbox.id); events.push("prepare"); },
    observe: (event: { stage: string }) => { events.push(event.stage); } };
}

test("an active template is reused without allocating or preparing a world", async () => {
  const events: string[] = [];
  const api = fakeApi({ getSnapshot: async () => ({ id: "template", name: "template", state: "active" }) });
  assert.deepEqual(await prepareWorldLayer(api, layer(events), sha), { name: "template" });
  assert.deepEqual(events, ["daytona-world"]);
});

for (const state of ["missing", "snapshotting", "error"]) {
  test(`a ${state} template gets a unique prepared VM, without snapshotting or touching the shared builder`, async () => {
    const events: string[] = [];
    const api = fakeApi({
      getSnapshot: async () => state === "missing" ? null : { id: "template", name: "template", state },
      createSandbox: async (input) => {
        assert.match(input.name, /^ow-dy-evidence-[a-f0-9]{32}$/);
        assert.equal(input.snapshot, "warm-image");
        assert.deepEqual(input.labels, sandbox.labels);
        assert.equal(input.autoStopMinutes, 30);
        assert.equal(input.autoDeleteMinutes, 0);
        events.push("create"); return sandbox;
      },
      waitForSandbox: async () => { events.push("started"); return sandbox; },
      execChecked: async () => { events.push("sync"); return ""; },
    });
    assert.deepEqual(await prepareWorldLayer(api, layer(events), sha), { sandbox });
    assert.deepEqual(events, ["parent", "create", "started", "prepare", "daytona-world-prepare", "sync", "daytona-world"]);
  });
}

test("Core ownership is present in the creation request even if its response is lost", async () => {
  const api = fakeApi({ getSnapshot: async () => null, createSandbox: async input => {
    assert.equal(input.labels.previewOwner, "123-1-core");
    assert.equal(input.labels.previewSource, input.name);
    assert.equal(input.labels.sourceSha, sha);
    throw new Error("creation response lost");
  } });
  await assert.rejects(prepareWorldLayer(api, layer([]), sha, "123-1-core"), /creation response lost/);
  await assert.rejects(launchDaytonaEvidenceWorld({ name: "cached", runtimeFingerprint: fingerprint }, sha, api, "123-1-core"), /creation response lost/);
});

test("failed preparation deletes only its owned VM before surfacing the error", async () => {
  const events: string[] = [];
  const api = fakeApi({ getSnapshot: async () => null, createSandbox: async () => sandbox,
    waitForSandbox: async () => sandbox, deleteSandbox: async (id) => { assert.equal(id, sandbox.id); events.push("delete"); } });
  await assert.rejects(prepareWorldLayer(api, { ...layer(events), prepare: async () => { throw new Error("prepare failed"); } }, sha), /prepare failed/);
  assert.deepEqual(events, ["parent", "delete"]);
});

test("saved layers still snapshot, wait for storage and release the builder lock", async () => {
  const events: string[] = [];
  const api = fakeApi({ getSnapshot: async () => null, getSandbox: async () => null,
    createSandbox: async (input) => { assert.equal(input.labels.kind, "openwork-daytona-builder-v1"); return sandbox; },
    waitForSandbox: async () => sandbox, execChecked: async () => { events.push("sync"); return ""; },
    snapshotSandbox: async (_id, name, memory) => { assert.equal(name, "template"); assert.equal(memory, true); events.push("snapshot"); },
    waitForSnapshot: async () => { events.push("saved"); return { id: "template", name: "template", state: "active" }; },
    deleteSandbox: async () => { events.push("delete"); } });
  assert.equal(await ensureLayer(api, layer(events)), "template");
  assert.deepEqual(events, ["parent", "prepare", "daytona-world-prepare", "sync", "snapshot", "saved", "daytona-world-snapshot", "daytona-world", "delete"]);
});

test("prepared worlds require matching ownership and source before adoption", async () => {
  const api = fakeApi();
  await assert.rejects(launchDaytonaEvidenceWorld({ sandbox: { ...sandbox, labels: {} }, runtimeFingerprint: fingerprint }, sha, api), /unrelated prepared world/);
  await assert.rejects(launchDaytonaEvidenceWorld({ sandbox, runtimeFingerprint: fingerprint }, "c".repeat(40), api), /unrelated prepared world/);
});

test("a prepared source marker mismatch deletes the owned world", async () => {
  const deleted: string[] = [];
  const api = fakeApi({ waitForSandbox: async () => sandbox, readFile: async () => "c".repeat(40),
    deleteSandbox: async (id) => { deleted.push(id); } });
  await assert.rejects(launchDaytonaEvidenceWorld({ sandbox, runtimeFingerprint: fingerprint }, sha, api), /Prepared world source mismatch/);
  assert.deepEqual(deleted, [sandbox.id]);
});

test("Core launch diagnostics emit only fixed status fields, never provider output or credentials", async () => {
  const messages: string[] = [];
  const warn = console.warn;
  console.warn = message => { messages.push(String(message)); };
  const api = fakeApi({ waitForSandbox: async () => sandbox, readFile: async () => "wrong-sha",
    exec: async () => ({ exitCode: 0, output: JSON.stringify({ browser: 200, gateway: 502, token: "must-not-be-logged" }) }),
    deleteSandbox: async () => {} });
  try {
    await assert.rejects(launchDaytonaEvidenceWorld({ sandbox, runtimeFingerprint: fingerprint }, sha, api, "123-1-core"), /Prepared world source mismatch/);
    assert.deepEqual(messages, [JSON.stringify({ stage: "core-browser-health", browser: 200, gateway: 502 })]);
  } finally { console.warn = warn; }
});

test("a prepared world uses the normal private access handshake without allocating a second VM", async () => {
  const writes: string[] = [];
  const api = fakeApi({ waitForSandbox: async () => sandbox,
    readFile: async (_vm, path) => path.endsWith("built-from-sha") ? sha : path.endsWith("evidence-ready") ? "web-v1" : fingerprint,
    previewUrl: async (_id, port) => ({ url: `https://port-${port}.test`, token: "preview-token" }),
    writeFile: async (_vm, path, content, mode) => {
      assert.equal(path, "/opt/openwork-preview/access.json"); assert.equal(mode, 0o600);
      const access = JSON.parse(content);
      assert.equal(access.sourceSha, sha); assert.equal(access.sandboxId, sandbox.id); writes.push(access.token);
    } });
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.ok(init?.headers); return new Response("{}", { status: 200 });
  };
  try {
    const session = await launchDaytonaEvidenceWorld({ sandbox, runtimeFingerprint: fingerprint }, sha, api);
    assert.equal(session.id, sandbox.id);
    assert.equal(session.cookie, `__Host-openwork-preview=${writes[0]}`);
    assert.equal(session.cdp.previewToken, "preview-token");
  } finally { globalThis.fetch = original; }
});
