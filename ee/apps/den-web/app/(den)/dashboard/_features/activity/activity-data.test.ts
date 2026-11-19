import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { DASHBOARD_ACTIVITY_PATH, fetchDashboardActivity, type ActivityRequest } from "./activity-data";

const dates = [
  "2026-10-01T12:00:00.000Z",
  "2026-10-02T12:00:00.000Z",
  "2026-10-03T12:00:00.000Z",
  "2026-10-04T12:00:00.000Z",
  "2026-10-05T12:00:00.000Z",
  "2026-10-06T12:00:00.000Z",
];

function serverEntries() {
  return [
    { id: "skill:v2", kind: "skill", title: "A new version of Research skill was published", detail: "Skill in Research", occurredAt: dates[5], target: { type: "skill", pluginId: "plugin-1", skillId: "skill-1" } },
    { id: "provider:legacy:provider-1", kind: "provider", title: "Team models was added", detail: "Model provider", occurredAt: dates[4], target: { type: "llm_provider", llmProviderId: "provider-1" }, logo: { name: "Team models", providerId: "example" } },
    { id: "provider:gateway:gateway-1", kind: "provider", title: "Gateway models was added", detail: "Model provider", occurredAt: dates[3], target: { type: "gateway_provider", inferenceProviderId: "gateway-1" }, logo: { name: "Gateway models", providerId: "example" } },
    { id: "plugin:attachment-1", kind: "plugin", title: "Research was added to the Team marketplace", detail: "Plugin with 1 skill", occurredAt: dates[2], target: { type: "marketplace", marketplaceId: "market-1" } },
    { id: "connection:connection-1", kind: "connection", title: "Docs was added", detail: "Connection", occurredAt: dates[0], target: { type: "connection", connectionId: "connection-1" }, logo: { name: "Docs", url: "https://docs.example/mcp" } },
  ];
}

function requestFrom(payload: () => unknown, seen: string[] = []): ActivityRequest {
  return async (path, signal) => {
    signal.throwIfAborted();
    seen.push(path);
    return payload();
  };
}

function load(request: ActivityRequest, signal = new AbortController().signal, orgSlug: string | null = "workspace") {
  return fetchDashboardActivity({ orgSlug, request, signal });
}

test("reads Den's computed activity in exactly one request", async () => {
  const seen: string[] = [];
  const entries = await load(requestFrom(() => ({ activity: serverEntries() }), seen));
  assert.deepEqual(seen, [DASHBOARD_ACTIVITY_PATH]);
  assert.equal(DASHBOARD_ACTIVITY_PATH, "/v1/org/activity");
  assert.deepEqual(entries.map((entry) => entry.id), [
    "skill:v2", "provider:legacy:provider-1", "provider:gateway:gateway-1", "plugin:attachment-1", "connection:connection-1",
  ]);
  assert.deepEqual(entries.map((entry) => entry.occurredAt), [dates[5], dates[4], dates[3], dates[2], dates[0]]);
});

test("builds each destination and action from the returned target", async () => {
  const entries = await load(requestFrom(() => ({ activity: serverEntries() })), new AbortController().signal, null);
  assert.deepEqual(entries.map((entry) => [entry.href, entry.action]), [
    ["/dashboard/plugins/plugin-1/skills/skill-1", "Open"],
    ["/dashboard/custom-llm-providers/provider-1", "Open"],
    ["/dashboard/ai-gateway/providers/gateway-1", "Open"],
    ["/dashboard/marketplaces/market-1", "Browse"],
    ["/dashboard/mcp-connections/connection-1", "Open"],
  ]);
  assert.deepEqual(entries[1]?.logo, { name: "Team models", providerId: "example" });
  assert.deepEqual(entries[4]?.logo, { name: "Docs", url: "https://docs.example/mcp" });
  assert.equal("logo" in (entries[3] ?? {}), false);
  assert.equal("target" in (entries[0] ?? {}), false);
});

test("an empty workspace is a successful empty snapshot", async () => {
  assert.deepEqual(await load(requestFrom(() => ({ activity: [] }))), []);
});

test("malformed responses and dates fail instead of rendering guessed rows", async () => {
  await assert.rejects(load(requestFrom(() => ({ connections: [] }))));
  const [first] = serverEntries();
  await assert.rejects(load(requestFrom(() => ({ activity: [{ ...first, occurredAt: "yesterday" }] }))));
  await assert.rejects(load(requestFrom(() => ({ activity: [{ ...first, target: { type: "unknown" } }] }))));
});

test("never shows more than five rows", async () => {
  const extra = { ...serverEntries()[4], id: "connection:connection-2", target: { type: "connection", connectionId: "connection-2" } };
  const entries = await load(requestFrom(() => ({ activity: [...serverEntries(), extra] })));
  assert.equal(entries.length, 5);
});

test("propagates cancellation", async () => {
  const controller = new AbortController();
  await assert.rejects(load(async (_path, signal) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    return { activity: serverEntries() };
  }, controller.signal), { name: "AbortError" });
  const aborted = new AbortController();
  aborted.abort();
  const seen: string[] = [];
  await assert.rejects(load(requestFrom(() => ({ activity: [] }), seen), aborted.signal), { name: "AbortError" });
  assert.deepEqual(seen, []);
});

test("a failed refresh retains the complete cached snapshot; initial errors are not empty", async () => {
  let payload: unknown = { activity: serverEntries().slice(4) };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryKey = ["activity", "org-1", "member-1"];
  try {
    const previous = await client.fetchQuery({ queryKey, queryFn: () => load(requestFrom(() => payload)) });
    payload = { unexpected: [] };
    await assert.rejects(client.fetchQuery({ queryKey, queryFn: () => load(requestFrom(() => payload)) }));
    assert.deepEqual(client.getQueryData(queryKey), previous);
    assert.equal(client.getQueryState(queryKey)?.status, "error");
    const initialKey = ["activity", "org-2", "member-2"];
    await assert.rejects(client.fetchQuery({ queryKey: initialKey, queryFn: () => load(requestFrom(() => payload)) }));
    assert.equal(client.getQueryData(initialKey), undefined);
  } finally {
    client.clear();
  }
});
