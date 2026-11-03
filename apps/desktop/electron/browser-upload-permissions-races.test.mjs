import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBrowserUploadGrantStore, createBrowserUploadPermissions } from "./browser-upload-permissions.mjs";
import { createComputerControl, COMPUTER_PROTOCOL } from "@openwork/computer-use/computer-control";

const origin = "https://files.example.test";
const scope = { baseUrl: "https://den.example.test", organizationId: "org_fixture", memberId: "member_a" };
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "upload-race-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, "files"); await mkdir(folder);
  const file = path.join(folder, "a.txt"); await writeFile(file, "fixture");
  return { folder, file, store: createBrowserUploadGrantStore({ directory: path.join(root, "grants") }) };
}
const rule = (effect, resource) => ({ action: "browser_upload", resource, effect, source: "Everyone" });

test("revoking while the final policy read waits invalidates its answer after that read finishes", async (t) => {
  const f = await fixture(t);
  await f.store.remember(scope, origin, f.folder, [f.file]);
  const policy = { enabled: true, scope, rules: [] };
  let hold = false;
  const started = deferred(), release = deferred();
  const service = createBrowserUploadPermissions({ store: f.store, readPolicy: async () => {
    if (hold) { hold = false; started.resolve(); await release.promise; }
    return policy;
  } });
  const authorization = await service.approve("chat", { url: `${origin}/upload`, files: [f.file] }, new AbortController().signal);
  const { grants } = await service.list();
  hold = true;
  const checking = authorization.revalidate();
  await started.promise;
  await service.remove(grants[0].id);
  release.resolve();
  assert.equal(await checking, false);
});

test("a same-origin receiving frame is still checked against its path-specific admin policy", async (t) => {
  const f = await fixture(t);
  const policy = { enabled: true, scope, rules: [rule("allow", "*"), rule("deny", "files.example.test/blocked")] };
  const service = createBrowserUploadPermissions({ store: f.store, readPolicy: async () => policy });
  const authorization = await service.approve("chat", { url: `${origin}/upload`, files: [f.file] }, new AbortController().signal);
  assert.equal(await authorization.revalidate(`${origin}/upload`), true);
  assert.equal(await authorization.revalidate(`${origin}/blocked/frame`), false);
  assert.equal(await authorization.revalidate("https://other.example.test/upload"), false);
});

test("the real broker cannot reuse one account's Always in the same chat after a member, org or deployment switch", async (t) => {
  const f = await fixture(t);
  const requests = [];
  const broker = createComputerControl({
    adapters: [{ id: "local", label: "This computer", placement: "local", protocol: COMPUTER_PROTOCOL,
      readiness: async () => ({ readiness: "ready", detail: "ready" }), connect: async () => { throw new Error("not controlling apps"); } }],
    onRequest: (_session, request) => { if (request) requests.push(request); },
  });
  t.after(() => broker.reset(true));
  let activeScope = scope;
  const service = createBrowserUploadPermissions({ store: f.store,
    readPolicy: async () => ({ enabled: true, scope: activeScope, rules: [] }),
    requestFiles: (request, options) => broker.requestBrowserFiles(request, options),
  });
  async function ask() {
    const before = requests.length;
    const pending = service.approve("same_chat", { url: `${origin}/upload`, files: [f.file] }, new AbortController().signal);
    for (let i = 0; i < 100 && requests.length === before; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(requests.length, before + 1, "new account needs its own consent, even in the same chat");
    await broker.answerRequest({ sessionId: "same_chat", id: requests.at(-1).id, answer: "always" });
    assert.equal((await pending).allowed, true);
  }
  await ask();
  assert.equal((await service.approve("same_chat", { url: `${origin}/upload`, files: [f.file] }, new AbortController().signal)).allowed, true);
  assert.equal(requests.length, 1);
  for (const other of [{ ...scope, memberId: "member_b" }, { ...scope, organizationId: "org_other" }, { ...scope, baseUrl: "https://other-den.example.test" }]) {
    activeScope = other;
    await ask();
  }
});
