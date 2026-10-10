import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { fetchDashboardActivity, type ActivityVersions } from "./activity-data";

/** Virtual transport time: exercise the real loader without wall-clock flakiness. */
async function measure(plugins: number, skillsPerPlugin: number) {
  const data: Record<string, unknown> = {
    "/v1/mcp-connections?scope=manageable": { connections: [] },
    "/v1/llm-providers?scope=manageable": { llmProviders: [] },
    "/v1/marketplaces?status=active&limit=100": { items: [], nextCursor: null },
    "/v1/plugins?status=active&limit=100": {
      items: Array.from({ length: plugins }, (_, i) => ({ id: `p${i}`, name: `Handbook ${i}`, status: "active", deletedAt: null })), nextCursor: null,
    },
  };
  const createdAt = (p: number, s: number) => new Date(Date.UTC(2026, 9, 1, 0, p, s)).toISOString();
  for (let p = 0; p < plugins; p++) {
    data[`/v1/plugins/p${p}/resolved`] = {
      items: Array.from({ length: skillsPerPlugin }, (_, s) => ({
        removedAt: null,
        configObject: { id: `s${p}-${s}`, title: `Briefing ${p}-${s}`, objectType: "skill", status: "active", deletedAt: null,
          latestVersion: { id: `v${p}-${s}`, configObjectId: `s${p}-${s}`, createdAt: createdAt(p, s), isDeletedVersion: false } },
      })), nextCursor: null,
    };
    for (let s = 0; s < skillsPerPlugin; s++) {
      data[`/v1/config-objects/s${p}-${s}/versions?limit=5&includeDeleted=false`] = {
        items: [{ id: `v${p}-${s}`, configObjectId: `s${p}-${s}`, createdAt: createdAt(p, s), isDeletedVersion: false }], nextCursor: null,
      };
    }
  }
  const cache = new Map<string, ActivityVersions>();
  async function visit() {
    let clock = 0;
    let done = false;
    const pending: { at: number; release: () => void }[] = [];
    const requests: { path: string; start: number; end: number }[] = [];
    const result = fetchDashboardActivity({
      orgSlug: null, gatewayEnabled: false, signal: new AbortController().signal,
      versionCache: {
        get: (skill, version) => cache.get(`${skill}:${version}`),
        set: (skill, version, versions) => { cache.set(`${skill}:${version}`, versions); },
      },
      request: async (path) => {
        assert(path in data, `Unexpected request: ${path}`);
        const request = { path, start: clock, end: clock + 150 };
        requests.push(request);
        await new Promise<void>((release) => pending.push({ at: request.end, release }));
        return data[path];
      },
    }).finally(() => { done = true; });
    for (let turn = 0; !done && turn < 1_000; turn++) {
      await setImmediate();
      if (done) break;
      assert(pending.length > 0, "Activity must not deadlock without an outstanding request");
      clock = Math.min(...pending.map((request) => request.at));
      for (const request of pending.filter((request) => request.at === clock)) {
        pending.splice(pending.indexOf(request), 1);
        request.release();
      }
    }
    assert(done, "Activity must settle");
    const entries = await result;
    return { ms: clock, requests: requests.length, entries: entries.map((entry) => entry.id) };
  }
  return { cold: await visit(), warm: await visit() };
}

test("a populated workspace resolves Activity without seconds of request waves", async (t) => {
  const small = await measure(1, 1);
  const populated = await measure(12, 8);
  const minimal = await measure(1, 56);
  const belowThreshold = await measure(1, 55);
  t.diagnostic(JSON.stringify({ transportMs: 150, small, populated, minimal, belowThreshold }));
  assert.deepEqual(populated.cold.entries, populated.warm.entries);
  assert(populated.cold.ms < 2_000, `Activity pending for ${populated.cold.ms}ms with 12 plugins / 96 skills`);
});
