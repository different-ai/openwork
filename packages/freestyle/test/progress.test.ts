import assert from "node:assert/strict";
import test from "node:test";
import { buildProgress } from "../src/progress.ts";

const sha = "a".repeat(40);
function vm(id: string, displayName: string, createdAt: string, state = "running") {
  return { id, displayName, createdAt, state, metadata: {}, resources: { cpu: 4, memory: 8192, storage: 32768 }, vpcs: [], networks: [], updatedAt: createdAt };
}
function fakeApi(vms: ReturnType<typeof vm>[], files: Record<string, string> = {}, queries: string[] = []) {
  return { vms: {
    list: async (options?: { metadata?: string }) => { queries.push(options?.metadata ?? ""); return { vms, totalCount: vms.length, runningCount: vms.length, startingCount: 0, pausingCount: 0, pausedCount: 0, stoppedCount: 0 }; },
    ref: (id: string) => ({ fs: {
      exists: async (path: string) => `${id}:${path}` in files,
      readTextFile: async (path: string) => files[`${id}:${path}`] ?? "",
    } }),
  } };
}

test("no live builder means not building, and the query is scoped to this commit and world", async () => {
  const queries: string[] = [];
  assert.deepEqual(await buildProgress(sha, "acme-web", fakeApi([], {}, queries)), { building: false, steps: [] });
  assert.deepEqual(queries, [`openworkBuild:acme-web-${sha}`]);
});

test("the newest live builder names the layer; services report finished steps with durations", async () => {
  const api = fakeApi([
    vm("vm-old", "OpenWork compiled builder", "2026-09-25T10:00:00Z", "stopped"),
    vm("vm-a", "OpenWork dependencies builder", "2026-09-25T10:01:00Z"),
    vm("vm-b", "OpenWork running-template builder", "2026-09-25T10:02:00Z"),
  ], {
    "vm-b:/opt/openwork-preview/build-stages.jsonl": '{"stage":"checkout","durationMs":5100}\n{"stage":"compile","durationMs":1900}\n',
    "vm-b:/opt/openwork-preview/runtime-stages.jsonl": '{"stage":"world-services","durationMs":44000}\n{"stage":"den-pages","durat',
  });
  const progress = await buildProgress(sha, "acme-web", api);
  assert.equal(progress.building, true);
  assert.equal(progress.layer, "running-template");
  assert.equal(progress.since, "2026-09-25T10:02:00Z");
  // A half-written last line is skipped rather than failing the whole read.
  assert.deepEqual(progress.steps, [{ id: "checkout", ms: 5100 }, { id: "compile", ms: 1900 }, { id: "world-services", ms: 44000 }]);
});

test("steps are only read while services start; other layers report the layer alone", async () => {
  const progress = await buildProgress(sha, "app-web", fakeApi([vm("vm-c", "OpenWork world builder", "2026-09-25T10:03:00Z")]));
  assert.deepEqual(progress, { building: true, layer: "world", since: "2026-09-25T10:03:00Z", steps: [] });
});
