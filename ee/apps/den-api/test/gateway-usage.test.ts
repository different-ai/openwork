import { INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference"
import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createDenDb } from "@openwork-ee/den-db"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:3306/not_connected"
process.env.DEN_DB_ENCRYPTION_KEY = "fixture-encryption-key-not-a-secret-32"
process.env.BETTER_AUTH_SECRET = "fixture-auth-key-not-a-secret-32-characters"
process.env.DEN_BASE_URL = "http://localhost:3005"
process.env.OPENWORK_DEV_MODE = "1"

// Exercise the actual Drizzle query construction and result mapping, with no
// network or production credentials. Only the driver's execution is stubbed.
const { db, client } = createDenDb({ mode: "planetscale", planetscale: {
  host: "database.example.test", username: "fixture", password: "fixture",
} })
if (!("connection" in client)) throw new Error("Expected the fixture PlanetScale driver")
let replies: unknown[][][] = []
const queries: string[] = []
const parameters: unknown[] = []
const execute = spyOn(client, "execute").mockImplementation(async (statement, args) => {
  queries.push(statement)
  parameters.push(args)
  const rows = replies.shift()
  if (!rows) throw new Error("Unexpected database query")
  return { headers: [], types: {}, rows, fields: [], size: rows.length, statement, insertId: "0", rowsAffected: 0, time: 0 }
})
mock.module("../src/db.js", () => ({ db }))
mock.module("../src/middleware/index.js", () => ({ orgMemberRoute: () => {}, queryValidator: () => {} }))
mock.module("../src/llm/models-dev.js", () => ({ getModelsDevProviders: async () => [] }))
const { readGatewayUsage } = await import("../src/routes/org/gateway-usage.js")

const org = createDenTypeId("organization")
const member = createDenTypeId("member")
const other = createDenTypeId("member")
const now = new Date("2026-01-31T12:00:00Z")

function bucket(requestCount: string, missing: string, successfulMissing: string | null) {
  return { date: "2026-01-31", requestCount, totalTokens: "100", successfulUnreportedRequests: successfulMissing,
    upstreamErrorUnreportedRequests: "2", unreachableUnreportedRequests: "0", abortedUnreportedRequests: "0", rejectedUnreportedRequests: String(Number(missing) - Number(successfulMissing) - 2),
    unreportedRequests: missing, totalCostMicroUsd: "1000", unpricedRequests: missing }
}

beforeEach(() => { replies = []; queries.length = 0; parameters.length = 0 })
afterAll(() => { execute.mockRestore(); mock.restore() })

test("sums request counts and keeps unsuccessful gaps separate from successful gaps", async () => {
  replies = [
    [["series", member, JSON.stringify([bucket("100", "10", "1")]), null],
      ["series", other, JSON.stringify([bucket("20", "2", "0")]), null]],
    [[member, "Person A"], [other, "Person B"]],
  ]
  const { usage } = await readGatewayUsage(org, { groupBy: "person", days: 31, filterIds: [] }, now)
  expect(usage).toMatchObject({ requestCount: 120, unreportedRequests: 12, uncountableRequests: { ok: 1, upstream_error: 4, upstream_unreachable: 0, client_aborted: 0, rejected: 7 }, totalTokens: 200 })
  expect(usage.daily).toHaveLength(31)
  expect(queries[0]).toContain("`outcome` = 'ok'")
  expect(queries[0]).toContain("`gateway_usage_rollups`.`ok_count`")
  expect(queries[0]).toContain("uncountable_ok")
  expect(replies).toHaveLength(0)
})

test("does not invent successful coverage for mixed historical rollups", async () => {
  replies = [
    [["series", member, JSON.stringify([bucket("100", "10", null)]), null]],
    [[member, "Person A"]],
  ]
  const { usage } = await readGatewayUsage(org, { groupBy: "person", days: 31, filterIds: [] }, now)
  expect(usage.requestCount).toBe(100)
  expect(usage.unreportedRequests).toBe(10)
  expect(usage.uncountableRequests?.ok).toBeNull()
})

test("empty team grouping returns zero request coverage without reading request logs", async () => {
  replies = [[]]
  const { usage } = await readGatewayUsage(org, { groupBy: "team", days: 31, filterIds: [] }, now)
  expect(usage).toMatchObject({ emptyReason: "no_teams", requestCount: 0, uncountableRequests: { ok: 0, upstream_error: 0, upstream_unreachable: 0, client_aborted: 0, rejected: 0 } })
  expect(queries).toHaveLength(1)
  expect(queries[0]).not.toContain("gateway_request_logs")
})


test("legacy outcome classification is exact only when the rollup counters determine it", async () => {
  replies = [[], []]
  await readGatewayUsage(org, { groupBy: "person", days: 31, filterIds: [] }, now)
  const expression = /(coalesce\(`gateway_usage_rollups`\.`uncountable_ok_count`, case\s+when `gateway_usage_rollups`\.`ok_count`[\s\S]*?else null end\))/.exec(queries[0])?.[1]
  expect(expression).toBeDefined()
  if (!expression) throw new Error("Missing rollup coverage expression")
  // The generated CASE uses portable SQL; evaluate that exact expression for
  // the legacy cases, rather than implementing another copy of its arithmetic.
  const sqlite = new Database(":memory:")
  try {
    sqlite.run("create table gateway_usage_rollups (request_count integer, ok_count integer, total_tokens_count integer, uncountable_ok_count integer)")
    const cases = [
      { requests: 10, ok: 0, observed: null, expected: 0 },
      { requests: 10, ok: 10, observed: null, expected: null },
      { requests: 10, ok: 7, observed: 10, expected: 0 },
      { requests: 10, ok: 7, observed: 0, expected: 7 },
      { requests: 10, ok: 10, observed: 8, expected: 2 },
      { requests: 10, ok: 7, observed: 8, expected: null },
    ]
    for (const entry of cases) {
      sqlite.run("delete from gateway_usage_rollups")
      sqlite.run("insert into gateway_usage_rollups values (?, ?, ?, null)", [entry.requests, entry.ok, entry.observed])
      expect(sqlite.query(`select ${expression} as missing from gateway_usage_rollups`).get()).toEqual({ missing: entry.expected })
    }
    sqlite.run("update gateway_usage_rollups set uncountable_ok_count = 1")
    expect(sqlite.query(`select ${expression} as missing from gateway_usage_rollups`).get()).toEqual({ missing: 1 })
  } finally { sqlite.close() }
})


test("zero token points and empty series are omitted without dropping diagnostic counts or positive costs", async () => {
  const empty = { ...bucket("3", "3", "0"), totalTokens: "0", totalCostMicroUsd: "0" };
  const costOnly = { ...bucket("2", "2", "0"), totalTokens: "0", totalCostMicroUsd: "50" };
  replies = [
    [["series", member, JSON.stringify([empty]), null], ["series", other, JSON.stringify([costOnly]), null]],
    [[member, "Person A"], [other, "Person B"]],
  ];
  const { usage } = await readGatewayUsage(org, { groupBy: "person", days: 31, filterIds: [] }, now);
  expect(usage.series).toEqual([{ id: other, label: "Person B" }]);
  expect(usage.daily.every((day) => Object.keys(day.values).length === 0)).toBe(true);
  expect(usage.daily[30].costValues).toEqual({ [other]: 50 });
  expect(usage).toMatchObject({ totalTokens: 0, totalCostMicroUsd: 50, unreportedRequests: 5 });
});

test("raw missing-usage categories include only their own outcome and exclude reported zeros", async () => {
  replies = [[], []];
  await readGatewayUsage(org, { groupBy: "person", days: 31, filterIds: [] }, now);
  const expressions = [...new Set([...queries[0].matchAll(/sum\((case when `outcome` = '[^']+' and `total_tokens` is null then 1 else 0 end)\)/g)].map((match) => match[1]))];
  expect(expressions).toHaveLength(5);
  const sqlite = new Database(":memory:");
  try {
    sqlite.run("create table gateway_request_logs (outcome text, total_tokens integer)");
    for (const outcome of ["ok", "upstream_error", "upstream_unreachable", "client_aborted", "rejected"]) {
      sqlite.run("insert into gateway_request_logs values (?, null), (?, 0), (?, 100)", [outcome, outcome, outcome]);
    }
    for (const expression of expressions) {
      expect(sqlite.query(`select sum(${expression}) as missing from gateway_request_logs`).get()).toEqual({ missing: 1 });
    }
  } finally { sqlite.close(); }
});

test("a member filter narrows model usage to that person's requests and rollups", async () => {
  replies = [[], [], [], []]
  await readGatewayUsage(org, { groupBy: "model", days: 31, filterIds: [], memberId: member }, now)
  expect(queries[0]).toContain("`gateway_request_logs`.`org_membership_id` = ?")
  expect(queries[0]).toContain("`gateway_usage_rollups`.`org_membership_id` = ?")
  expect(JSON.stringify(parameters[0])).toContain(member)
  expect(JSON.stringify(parameters[0])).not.toContain(other)
})

test("usage without a member filter does not constrain the membership", async () => {
  replies = [[], [], [], []]
  await readGatewayUsage(org, { groupBy: "model", days: 31, filterIds: [] }, now)
  expect(queries[0]).not.toContain("`org_membership_id` = ")
})

test("OpenWork Models usage reports as its own family, labelled by its public model name and offered as a filter", async () => {
  const hex = (value: string) => Buffer.from(value).toString("hex").toUpperCase()
  const [modelId, alias] = Object.entries(INFERENCE_MODEL_ALIASES)[0]!
  const hosted = `model:${hex("openwork")}:${hex(modelId)}`
  replies = [
    [["series", hosted, JSON.stringify([bucket("4", "2", "0")]), null], ["option", "openwork", null, null]],
    [],
    [],
    [],
  ]
  const { usage } = await readGatewayUsage(org, { groupBy: "model", days: 31, filterIds: [] }, now)
  expect(usage.series).toEqual([{ id: hosted, label: alias.displayName }])
  expect(usage.filterOptions).toContainEqual({ id: "openwork", label: "OpenWork Models" })
  // The organization's own providers and hosted OpenWork Models both feed the read.
  expect(queries[0]).toContain("`route` in (")
  expect(queries[0]).toContain("`route` in ('openwork_openrouter') then")
})
