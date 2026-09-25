import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { POST } from "../app/r/[id]/launch/route.ts";
import { launchHandlers, type LaunchDependencies } from "../lib/launch.ts";
import type { PreviewSession } from "@openwork/freestyle";
import type { BuildProgress } from "@openwork/freestyle/progress";

const RUNNING: BuildProgress = { building: true, layer: "running-template", since: "2026-09-25T10:00:00Z", steps: [{ id: "checkout", ms: 5000 }] };

const sha = "c".repeat(40);
function fakes(ready: boolean, building = false) {
  const scheduled: (() => Promise<void>)[] = [];
  const calls = { built: 0, launched: 0, scheduled };
  const session: PreviewSession = { id: "vm-1", snapshotId: "sh-1", gitSha: sha, url: "https://ow-x.preview.openwork.software/", expiresAt: new Date(Date.now() + 3600_000).toISOString(), world: "app-web", outputs: {} };
  const deps: LaunchDependencies = {
    readReview: async () => ({ gitSha: sha }),
    hasSnapshot: async () => ready,
    launchPreview: async () => { calls.launched++; return session; },
    buildSnapshot: async () => { calls.built++; },
    buildProgress: async () => building ? RUNNING : { building: false, steps: [] },
    schedule: (task) => { calls.scheduled.push(task); },
    connected: () => true,
  };
  return { deps, calls };
}
const post = () => new Request("https://review.example/r/test/launch", { method: "POST", headers: { origin: "https://review.example" }, body: JSON.stringify({ world: "app-web" }) });
const params = { params: Promise.resolve({ id: "a".repeat(32) }) };

test("a commit without a snapshot is built after the response, never inside the request", async () => {
  const { deps, calls } = fakes(false);
  const response = await launchHandlers(deps).POST(post(), params);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { state: "building" });
  assert.equal(calls.built, 0, "the build must not run before the response");
  assert.equal(calls.launched, 0);
  assert.equal(calls.scheduled.length, 1);
  await calls.scheduled[0]();
  assert.equal(calls.built, 1);
});

test("a commit with a snapshot launches directly and schedules nothing", async () => {
  const { deps, calls } = fakes(true);
  const response = await launchHandlers(deps).POST(post(), params);
  assert.equal(response.status, 201);
  assert.equal(calls.launched, 1);
  assert.equal(calls.scheduled.length, 0);
});

test("readiness polling reports ready, building, or neither without building or launching", async () => {
  const cases: [boolean, boolean, unknown][] = [
    [true, true, { ready: true, building: false }],
    [false, true, { ready: false, building: true, progress: RUNNING }],
    [false, false, { ready: false, building: false, progress: { building: false, steps: [] } }],
  ];
  for (const [ready, building, expected] of cases) {
    const { deps, calls } = fakes(ready, building);
    const response = await launchHandlers(deps).GET(new Request("https://review.example/r/test/launch?world=acme-web"), params);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
    assert.equal(calls.built + calls.launched + calls.scheduled.length, 0);
  }
  const { deps } = fakes(true);
  assert.equal((await launchHandlers(deps).GET(new Request("https://review.example/r/test/launch?world=moon"), params)).status, 400);
});

test("a failed background build is logged, not thrown into the runtime", async () => {
  const { deps, calls } = fakes(false);
  deps.buildSnapshot = async () => { throw new Error("builder died"); };
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    await launchHandlers(deps).POST(post(), params);
    await calls.scheduled[0]();
  } finally { console.error = original; }
  assert.equal(logged.length, 1);
});

test("launch rejects cross-site requests before looking up reports or creating VMs", async () => {
  const response = await POST(new Request("https://review.example/r/test/launch", {
    method: "POST", headers: { origin: "https://unrelated.example" },
  }), { params: Promise.resolve({ id: "a".repeat(32) }) });
  assert.equal(response.status, 403);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("launch fails closed when disconnected, and refuses missing reports when connected", async () => {
  const savedKey = process.env.FREESTYLE_API_KEY;
  const savedDirectory = process.env.OPENWORK_REVIEW_LOCAL_DIR;
  const directory = await mkdtemp(join(tmpdir(), "openwork-review-launch-"));
  const request = () => new Request("https://review.example/r/test/launch", { method: "POST", headers: { origin: "https://review.example" } });
  const params = { params: Promise.resolve({ id: "a".repeat(32) }) };
  try {
    delete process.env.FREESTYLE_API_KEY;
    assert.equal((await POST(request(), params)).status, 503);
    process.env.FREESTYLE_API_KEY = "synthetic-not-a-real-key";
    process.env.OPENWORK_REVIEW_LOCAL_DIR = directory;
    assert.equal((await POST(request(), params)).status, 404);
  } finally {
    if (savedKey === undefined) delete process.env.FREESTYLE_API_KEY;
    else process.env.FREESTYLE_API_KEY = savedKey;
    if (savedDirectory === undefined) delete process.env.OPENWORK_REVIEW_LOCAL_DIR;
    else process.env.OPENWORK_REVIEW_LOCAL_DIR = savedDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-origin check honors the requested host behind Next's local URL normalization", async () => {
  const saved = process.env.FREESTYLE_API_KEY;
  delete process.env.FREESTYLE_API_KEY;
  try {
    const response = await POST(new Request("http://localhost:3011/r/test/launch", {
      method: "POST", headers: { host: "127.0.0.1:3011", origin: "http://127.0.0.1:3011" },
    }), { params: Promise.resolve({ id: "a".repeat(32) }) });
    assert.equal(response.status, 503);
  } finally { if (saved !== undefined) process.env.FREESTYLE_API_KEY = saved; }
});
