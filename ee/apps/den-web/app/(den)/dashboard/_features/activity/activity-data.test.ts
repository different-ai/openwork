import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { fetchDashboardActivity, type ActivityRequest, type ActivityVersions } from "./activity-data";

const dates = [
  "2026-10-01T12:00:00.000Z",
  "2026-10-02T12:00:00.000Z",
  "2026-10-03T12:00:00.000Z",
  "2026-10-04T12:00:00.000Z",
  "2026-10-05T12:00:00.000Z",
  "2026-10-06T12:00:00.000Z",
];
const pluginsPath = "/v1/plugins?status=active&limit=100";
const marketplacesPath = "/v1/marketplaces?status=active&limit=100";
const connectionsPath = "/v1/mcp-connections?scope=manageable";
const providersPath = "/v1/llm-providers?scope=manageable";
const gatewayPath = "/v1/inference-providers?scope=manageable";
const versionsPath = "/v1/config-objects/skill-1/versions?limit=5&includeDeleted=false";

function plugin(id = "plugin-1") {
  return { id, name: "Research", status: "active", deletedAt: null, memberCount: 99 };
}
function membership(id: string, objectType = "skill") {
  return {
    removedAt: null,
    configObject: { id, title: "Research skill", objectType, status: "active", deletedAt: null },
  };
}
function version(id: string, createdAt: unknown) {
  return { id, configObjectId: "skill-1", createdAt, isDeletedVersion: false };
}
function fixtures(): Record<string, unknown> {
  return {
    [connectionsPath]: { connections: [] },
    [providersPath]: { llmProviders: [] },
    [gatewayPath]: { inferenceProviders: [] },
    [pluginsPath]: { items: [], nextCursor: null },
    [marketplacesPath]: { items: [], nextCursor: null },
  };
}
function requestFrom(data: Record<string, unknown>, seen: string[] = []): ActivityRequest {
  return async (path, signal) => {
    signal.throwIfAborted();
    seen.push(path);
    if (!(path in data)) throw new Error(`Unexpected request: ${path}`);
    return data[path];
  };
}
function load(data: Record<string, unknown>, request = requestFrom(data), signal = new AbortController().signal) {
  return fetchDashboardActivity({ orgSlug: "workspace", gatewayEnabled: true, request, signal });
}
function addPlugin(data: Record<string, unknown>) {
  data[pluginsPath] = { items: [plugin()], nextCursor: null };
  data["/v1/plugins/plugin-1/resolved"] = { items: [membership("skill-1")], nextCursor: null };
  data[versionsPath] = { items: [], nextCursor: null };
}
function addMarketplace(data: Record<string, unknown>, createdAt: unknown) {
  data[marketplacesPath] = { items: [{ id: "market-1", name: "Team", status: "active", deletedAt: null }], nextCursor: null };
  data["/v1/marketplaces/market-1/plugins"] = {
    items: [{ id: "attachment-1", pluginId: "plugin-1", membershipSource: "manual", createdAt, updatedAt: dates[5], removedAt: null }],
    nextCursor: null,
  };
}

test("merges creation and multiple immutable version events into the newest five", async () => {
  const data = fixtures();
  addPlugin(data);
  addMarketplace(data, dates[2]);
  data[connectionsPath] = { connections: [{ id: "connection-1", name: "Docs", createdAt: dates[0] }] };
  data[providersPath] = { llmProviders: [{ id: "provider-1", providerId: "example", name: "Team models", createdAt: dates[4] }] };
  data[gatewayPath] = { inferenceProviders: [{ id: "gateway-1", providerId: "example", name: "Gateway models", createdAt: dates[3] }] };
  data[versionsPath] = { items: [version("v2", dates[5]), version("v1", dates[1])], nextCursor: null };
  const entries = await load(data);
  assert.deepEqual(entries.map((entry) => entry.id), [
    "skill:v2", "provider:legacy:provider-1", "provider:gateway:gateway-1", "plugin:attachment-1", "skill:v1",
  ]);
  assert.equal(entries[0]?.title, "A new version of Research skill was published");
  assert.equal(entries[0]?.detail, "Skill in Research");
  assert.equal(entries[0]?.href, "/dashboard/plugins/plugin-1/skills/skill-1");
  assert.equal(entries[1]?.title, "Team models was added");
  assert.equal(entries[2]?.href, "/dashboard/ai-gateway/providers/gateway-1");
  assert.equal(entries[3]?.title, "Research was added to the Team marketplace");
  assert.equal(entries[3]?.occurredAt, dates[2]);
  assert.equal(entries[3]?.action, "Browse");
});

test("missing/invalid createdAt is skipped, never replaced by update or connection dates", async () => {
  const data = fixtures();
  addPlugin(data);
  addMarketplace(data, undefined);
  data[connectionsPath] = { connections: [
    { id: "missing", name: "Missing", connectedAt: dates[5], updatedAt: dates[5] },
    { id: "invalid", name: "Invalid", createdAt: "yesterday", updatedAt: dates[5] },
    { id: "null", name: "Null", createdAt: null },
    { id: "valid", name: "Valid", createdAt: dates[0], updatedAt: dates[5], connected: false },
  ] };
  data[providersPath] = { llmProviders: [{ id: "missing", name: "Missing", providerId: "example", updatedAt: dates[5] }] };
  data[versionsPath] = { items: [version("missing", undefined), { ...version("deleted", dates[5]), isDeletedVersion: true }], nextCursor: null };
  assert.deepEqual(await load(data), [{
    id: "connection:valid", kind: "connection", title: "Valid was added", detail: "Connection",
    occurredAt: dates[0], href: "/dashboard/mcp-connections/valid", action: "Open", logo: { name: "Valid" },
  }]);
});

test("counts actual active skill contents, excluding non-skills and removed/deleted resources", async () => {
  const data = fixtures();
  addPlugin(data);
  addMarketplace(data, dates[0]);
  data["/v1/plugins/plugin-1/resolved"] = {
    items: [membership("skill-1"), membership("skill-1"), membership("hook-1", "hook"),
      { ...membership("removed"), removedAt: dates[1] },
      { removedAt: null, configObject: { ...membership("deleted").configObject, status: "deleted", deletedAt: dates[1] } }],
    nextCursor: null,
  };
  data["/v1/marketplaces/market-1/plugins"] = {
    items: [
      { id: "first", pluginId: "plugin-1", membershipSource: "manual", createdAt: dates[0], updatedAt: dates[5], removedAt: null },
      { id: "removed", pluginId: "plugin-1", membershipSource: "manual", createdAt: dates[5], removedAt: dates[5] },
      { id: "invisible-plugin", pluginId: "not-authorized", membershipSource: "manual", createdAt: dates[5], removedAt: null },
    ], nextCursor: null,
  };
  const entries = await load(data);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.detail, "Plugin with 1 skill");
  assert.equal(entries[0]?.occurredAt, dates[0]);
});

test("built-in catalog provisioning is not presented as new workspace activity", async () => {
  const data = fixtures();
  addPlugin(data);
  addMarketplace(data, dates[0]);
  data["/v1/marketplaces/market-1/plugins"] = {
    items: [{ id: "seeded", pluginId: "plugin-1", membershipSource: "system", createdAt: dates[5], removedAt: null }],
    nextCursor: null,
  };
  assert.deepEqual(await load(data), []);
});

test("follows discovery and content pagination and limits each skill to five versions", async () => {
  const data = fixtures();
  addPlugin(data);
  addMarketplace(data, dates[0]);
  data[pluginsPath] = { items: [], nextCursor: "next plugin" };
  data[`${pluginsPath}&cursor=next%20plugin`] = { items: [plugin()], nextCursor: null };
  data[marketplacesPath] = { items: [], nextCursor: "market-page" };
  data[`${marketplacesPath}&cursor=market-page`] = { items: [{ id: "market-1", name: "Team", status: "active", deletedAt: null }], nextCursor: null };
  data[connectionsPath] = { connections: [], nextCursor: "connection-page" };
  data[`${connectionsPath}&cursor=connection-page`] = { connections: [{ id: "connection-1", name: "Docs", createdAt: dates[5] }], nextCursor: null };
  data["/v1/plugins/plugin-1/resolved"] = { items: [membership("hook", "hook")], nextCursor: "contents" };
  data["/v1/plugins/plugin-1/resolved?cursor=contents"] = { items: [membership("skill-1")], nextCursor: null };
  data[versionsPath] = { items: [version("v5", dates[4]), version("v4", dates[3])], nextCursor: "versions-page" };
  data[`${versionsPath}&cursor=versions-page`] = { items: [version("v3", dates[2]), version("v2", dates[1]), version("v1", dates[0])], nextCursor: "must-not-fetch" };
  const seen: string[] = [];
  const entries = await load(data, requestFrom(data, seen));
  assert.deepEqual(entries.map((entry) => entry.id), ["connection:connection-1", "skill:v5", "skill:v4", "skill:v3", "skill:v2"]);
  assert(seen.includes(`${pluginsPath}&cursor=next%20plugin`));
  assert(seen.includes(`${marketplacesPath}&cursor=market-page`));
  assert(!seen.some((path) => path.includes("must-not-fetch")));
});

test("unsupported gateways are skipped but admin connection management is always read", async () => {
  const seen: string[] = [];
  const entries = await fetchDashboardActivity({
    orgSlug: null, gatewayEnabled: false,
    signal: new AbortController().signal, request: requestFrom(fixtures(), seen),
  });
  assert.deepEqual(entries, []);
  assert(!seen.includes(gatewayPath));
  assert(seen.includes(connectionsPath));
});

test("reuses version metadata only while the freshly authorized latest version is unchanged", async () => {
  const data = fixtures();
  addPlugin(data);
  const contentsPath = "/v1/plugins/plugin-1/resolved";
  const skill = membership("skill-1");
  data[contentsPath] = { items: [{ ...skill, configObject: { ...skill.configObject, latestVersion: { id: "v1" } } }], nextCursor: null };
  data[versionsPath] = { items: [version("v1", dates[0])], nextCursor: null };
  const cache = new Map<string, ActivityVersions>();
  const seen: string[] = [];
  const input = {
    orgSlug: null,
    gatewayEnabled: false,
    signal: new AbortController().signal,
    request: requestFrom(data, seen),
    versionCache: {
      get: (skillId: string, revision: string) => cache.get(`${skillId}:${revision}`),
      set: (skillId: string, revision: string, versions: ActivityVersions) => { cache.set(`${skillId}:${revision}`, versions); },
    },
  };
  await fetchDashboardActivity(input);
  await fetchDashboardActivity(input);
  assert.equal(seen.filter((path) => path === contentsPath).length, 2);
  assert.equal(seen.filter((path) => path === versionsPath).length, 1);
  data[contentsPath] = { items: [{ ...skill, configObject: { ...skill.configObject, latestVersion: { id: "v2" } } }], nextCursor: null };
  data[versionsPath] = { items: [version("v2", dates[1]), version("v1", dates[0])], nextCursor: null };
  const refreshed = await fetchDashboardActivity(input);
  assert.equal(seen.filter((path) => path === versionsPath).length, 2);
  assert.equal(refreshed[0]?.id, "skill:v2");
});

test("old skill histories cannot displace five newer authorized events", async () => {
  const data = fixtures();
  addPlugin(data);
  data[connectionsPath] = { connections: dates.slice(1).map((createdAt, i) => ({ id: `c${i}`, name: `Docs ${i}`, createdAt })) };
  const skill = membership("skill-1");
  data["/v1/plugins/plugin-1/resolved"] = { items: [{ ...skill, configObject: { ...skill.configObject, latestVersion: version("v1", dates[0]) } }], nextCursor: null };
  // A pruned history must not be requested, even on a cold cache.
  delete data[versionsPath];
  const seen: string[] = [];
  const entries = await load(data, requestFrom(data, seen));
  assert.equal(entries.length, 5);
  assert(!seen.includes(versionsPath));
});

test("candidate pruning retains timestamp ties, multiple versions, and unknown bounds", async () => {
  const data = fixtures();
  addPlugin(data);
  data[connectionsPath] = { connections: dates.slice(1).map((createdAt, i) => ({ id: `c${i}`, name: `Docs ${i}`, createdAt })) };
  const skill = membership("skill-1");
  for (const latestVersion of [
    version("v2", dates[5]),
    { id: "v2" }, // Older servers: no invented timestamp or assumed bound.
    { ...version("v2", dates[0]), configObjectId: "another-skill" },
    version("v2", "invalid"),
    { ...version("deleted", dates[5]), isDeletedVersion: true },
  ]) {
    data["/v1/plugins/plugin-1/resolved"] = { items: [{ ...skill, configObject: { ...skill.configObject, latestVersion } }], nextCursor: null };
    data[versionsPath] = { items: [version("v2", dates[5]), version("v1", dates[4])], nextCursor: null };
    const seen: string[] = [];
    const entries = await load(data, requestFrom(data, seen));
    assert(seen.includes(versionsPath));
    assert.equal(entries.filter((entry) => entry.kind === "skill").length, 2);
  }
});

test("a history tied with the fifth event is read before applying the event-ID tiebreaker", async () => {
  const data = fixtures();
  addPlugin(data);
  data[connectionsPath] = { connections: dates.slice(1).map((createdAt, i) => ({ id: `c${i}`, name: `Docs ${i}`, createdAt })) };
  const skill = membership("skill-1");
  data["/v1/plugins/plugin-1/resolved"] = { items: [{ ...skill, configObject: { ...skill.configObject, latestVersion: version("v2", dates[1]) } }], nextCursor: null };
  data[versionsPath] = { items: [version("v2", dates[1]), version("v1", dates[0])], nextCursor: null };
  const seen: string[] = [];
  const entries = await load(data, requestFrom(data, seen));
  assert(seen.includes(versionsPath));
  assert.deepEqual(entries.map((entry) => entry.id), ["connection:c4", "connection:c3", "connection:c2", "connection:c1", "connection:c0"]);
});

test("a candidate-history failure keeps the previous complete snapshot while older histories are pruned", async () => {
  const data = fixtures();
  addPlugin(data);
  data[connectionsPath] = { connections: dates.slice(1).map((createdAt, i) => ({ id: `c${i}`, name: `Docs ${i}`, createdAt })) };
  const recent = membership("skill-1");
  const old = membership("old-skill");
  data["/v1/plugins/plugin-1/resolved"] = { items: [
    { ...recent, configObject: { ...recent.configObject, latestVersion: version("v2", dates[5]) } },
    { ...old, configObject: { ...old.configObject, latestVersion: { ...version("old", dates[0]), configObjectId: "old-skill" } } },
  ], nextCursor: null };
  data[versionsPath] = { items: [version("v2", dates[5])], nextCursor: null };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryKey = ["activity", "scoped-workspace"];
  try {
    const previous = await client.fetchQuery({ queryKey, queryFn: () => load(data) });
    delete data[versionsPath];
    await assert.rejects(client.fetchQuery({ queryKey, queryFn: () => load(data) }), /Unexpected request/);
    assert.deepEqual(client.getQueryData(queryKey), previous);
    assert.equal(client.getQueryState(queryKey)?.status, "error");
  } finally {
    client.clear();
  }
});

test("duplicate discovery rows and deleted latest versions cannot manufacture a cutoff", async () => {
  const data = fixtures();
  addPlugin(data);
  data[connectionsPath] = { connections: Array.from({ length: 5 }, () => ({ id: "same", name: "Docs", createdAt: dates[5] })) };
  const skill = membership("skill-1");
  data["/v1/plugins/plugin-1/resolved"] = { items: [{ ...skill, configObject: { ...skill.configObject, latestVersion: version("v1", dates[0]) } }], nextCursor: null };
  data[versionsPath] = { items: [version("v1", dates[0])], nextCursor: null };
  assert.deepEqual((await load(data)).map((entry) => entry.id), ["connection:same", "skill:v1"]);

  data[connectionsPath] = { connections: dates.slice(2).map((createdAt, i) => ({ id: `c${i}`, name: `Docs ${i}`, createdAt })) };
  data["/v1/plugins/plugin-1/resolved"] = { items: [{ ...skill, configObject: { ...skill.configObject, latestVersion: { ...version("deleted", dates[5]), isDeletedVersion: true } } }], nextCursor: null };
  assert.equal((await load(data)).some((entry) => entry.id === "skill:v1"), true);
});

test("pruned and exhaustive histories produce identical events across dated workspaces", async () => {
  for (let scenario = 0; scenario < 20; scenario++) {
    const data = fixtures();
    data[pluginsPath] = { items: [plugin()], nextCursor: null };
    const memberships = Array.from({ length: 30 }, (_, i) => {
      const skill = membership(`skill-${i}`);
      const versions = Array.from({ length: 5 }, (_, v) => ({
        id: `v${i}-${v}`, configObjectId: skill.configObject.id,
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, (i * 7 + scenario * 3) % 17, 5 - v)).toISOString(), isDeletedVersion: false,
      }));
      data[`/v1/config-objects/${skill.configObject.id}/versions?limit=5&includeDeleted=false`] = { items: versions, nextCursor: null };
      return { ...skill, configObject: { ...skill.configObject, latestVersion: versions[0] } };
    });
    data["/v1/plugins/plugin-1/resolved"] = { items: memberships, nextCursor: null };
    const seen: string[] = [];
    const pruned = await load(data, requestFrom(data, seen));
    data["/v1/plugins/plugin-1/resolved"] = { items: memberships.map(({ configObject, ...rest }) => ({
      ...rest, configObject: { ...configObject, latestVersion: { id: configObject.latestVersion?.id } },
    })), nextCursor: null };
    const exhaustive = await load(data);
    assert.deepEqual(pruned, exhaustive);
    assert(seen.filter((path) => path.includes("/versions?")).length < memberships.length);
  }
});

test("propagates cancellation and does not schedule another discovery page", async () => {
  const controller = new AbortController();
  const data = fixtures();
  data[pluginsPath] = { items: [], nextCursor: "never" };
  const seen: string[] = [];
  const request = requestFrom(data, seen);
  await assert.rejects(load(data, async (path, signal) => {
    assert.equal(signal, controller.signal);
    const result = await request(path, signal);
    if (path === pluginsPath) controller.abort();
    return result;
  }, controller.signal), { name: "AbortError" });
  assert(!seen.some((path) => path.includes("cursor=never")));
});

test("a failed refresh retains the complete cached snapshot; initial errors are not empty", async () => {
  const data = fixtures();
  data[connectionsPath] = { connections: [{ id: "connection-1", name: "Docs", createdAt: dates[0] }] };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryKey = ["activity", "org-1", "member-1"];
  try {
    const previous = await client.fetchQuery({ queryKey, queryFn: () => load(data) });
    data[connectionsPath] = { connections: [{ id: "new-connection", name: "New", createdAt: dates[5] }] };
    data[marketplacesPath] = { unexpected: [] };
    await assert.rejects(client.fetchQuery({ queryKey, queryFn: () => load(data) }));
    assert.deepEqual(client.getQueryData(queryKey), previous);
    assert.equal(client.getQueryState(queryKey)?.status, "error");
    const initialKey = ["activity", "org-2", "member-2"];
    await assert.rejects(client.fetchQuery({ queryKey: initialKey, queryFn: () => load(data) }));
    assert.equal(client.getQueryData(initialKey), undefined);
  } finally {
    client.clear();
  }
});

test("detail fanout remains bounded and pagination loops reject instead of truncating", async () => {
  const data = fixtures();
  const manyPlugins = Array.from({ length: 17 }, (_, index) => plugin(`plugin-${index}`));
  data[pluginsPath] = { items: manyPlugins, nextCursor: null };
  for (const item of manyPlugins) data[`/v1/plugins/${item.id}/resolved`] = { items: [], nextCursor: null };
  let active = 0;
  let maximum = 0;
  const request = requestFrom(data);
  await load(data, async (path, signal) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      return await request(path, signal);
    } finally {
      active--;
    }
  });
  assert(maximum <= 5);
  data[pluginsPath] = { items: [], nextCursor: "loop" };
  data[`${pluginsPath}&cursor=loop`] = { items: [], nextCursor: "loop" };
  await assert.rejects(load(data), /pagination did not advance/);
});
