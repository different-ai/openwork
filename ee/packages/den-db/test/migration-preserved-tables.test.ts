import assert from "node:assert/strict"
import test from "node:test"
import { matrixPreflightQueries, preflightMatrix } from "../scripts/dev-migrate.ts"
import { historyPrefix, loadMigrationPlan, physicalSchemaShape, recordedSchemaLayout, schemaDifferences, snapshotShape } from "../scripts/migration-baseline.ts"

const plan = loadMigrationPlan(new URL("../drizzle", import.meta.url).pathname)
const names = ["dashboard", "dashboard_access_grant"]
const creating = plan[77].snapshot
const final = plan.at(-1)?.snapshot
assert.ok(creating && final)
const preserved = new Map([...snapshotShape(creating)].filter(([key]) => names.some((name) => key === `table:${name}` || key.startsWith(`column:${name}.`) || key.startsWith(`index:${name}.`))))
const historical = physicalSchemaShape(plan, plan.length)
const bootstrap = snapshotShape(final)

function matches(actual: Map<string, string>) {
  return schemaDifferences(physicalSchemaShape(plan, plan.length, recordedSchemaLayout(plan, plan.length, actual)), actual)
}

function withoutTable(shape: Map<string, string>, name: string) {
  return new Map([...shape].filter(([key]) => key !== `table:${name}` && !key.startsWith(`column:${name}.`) && !key.startsWith(`index:${name}.`)))
}

test("logical snapshots and strict schema comparison remain unchanged", () => {
  assert.equal(preserved.size, 31)
  assert.deepEqual(schemaDifferences(bootstrap, historical), [...preserved.keys()].sort())
  assert.equal(historical.size, bootstrap.size + 31)
  for (const name of names) assert.equal(final.tables[name], undefined)
})

for (const applied of [77, 78, 96, 146, 147, plan.length]) test(`physical expectation for prefix ${applied} requires the complete historical pair only after creation`, () => {
  const shape = physicalSchemaShape(plan, applied)
  for (const [key, value] of preserved) assert.equal(shape.get(key), applied >= 78 ? value : undefined)
  assert.deepEqual(schemaDifferences(shape, physicalSchemaShape(plan, applied, "snapshot-bootstrap")), applied >= 147 ? [...preserved.keys()].sort() : [])
})

test("historical replay and current-schema bootstrap are distinct complete known layouts", () => {
  assert.equal(recordedSchemaLayout(plan, plan.length, historical), "historical-replay")
  assert.equal(recordedSchemaLayout(plan, plan.length, bootstrap), "snapshot-bootstrap")
  assert.deepEqual(matches(historical), [])
  assert.deepEqual(matches(bootstrap), [])
  // A fresh replay never selects a layout from its final inspected schema.
  assert.deepEqual(schemaDifferences(physicalSchemaShape(plan, plan.length), bootstrap), [...preserved.keys()].sort())
})

for (const [key, value] of preserved) {
  test(`a missing ${key} is not optional`, () => {
    const malformed = new Map(historical)
    malformed.delete(key)
    assert.deepEqual(matches(malformed), [key])
  })
  test(`a malformed ${key} is rejected`, () => {
    const malformed = new Map(historical)
    malformed.set(key, `${value}:malformed`)
    assert.deepEqual(matches(malformed), [key])
  })
}

for (const name of names) test(`the layout with only ${name} is rejected, not treated as bootstrap`, () => {
  const malformed = withoutTable(historical, names.find((other) => other !== name) ?? "")
  assert.equal(recordedSchemaLayout(plan, plan.length, malformed), "historical-replay")
  assert.ok(matches(malformed).length > 0)
})

for (const key of ["column:dashboard.exp_extra", "index:dashboard.exp_extra", "check:dashboard.exp_extra", "table:exp_unknown", "table:dashboard_backup"]) {
  for (const { label, shape } of [{ label: "historical", shape: historical }, { label: "bootstrap", shape: bootstrap }]) test(`${label} layout rejects unknown extra ${key}`, () => {
    const malformed = new Map(shape)
    malformed.set(key, "unexpected")
    assert.ok(matches(malformed).includes(key))
  })
}

test("bootstrap is accepted only when the rest of its entire schema matches", () => {
  const malformed = new Map(bootstrap)
  malformed.delete("column:user.id")
  assert.ok(matches(malformed).includes("column:user.id"))
})

for (const index of [77, 146]) test(`changed ${plan[index].tag} SQL fails closed even if its supplied hash is unchanged`, () => {
  const changed = structuredClone(plan)
  changed[index].sql[0] += "\nSELECT 1;"
  assert.throws(() => physicalSchemaShape(changed, changed.length), /Preserved dashboard migration definitions changed/)
})

for (const index of [77, 145]) {
  for (const mutation of ["type", "default", "nullability", "missing column", "index", "partial pair"]) test(`changed ${plan[index].tag} ${mutation} definition fails closed`, () => {
    const changed = structuredClone(plan)
    const snapshot = changed[index].snapshot
    assert.ok(snapshot)
    const table = snapshot.tables.dashboard
    if (mutation === "type") table.columns.name.type = "varchar(254)"
    if (mutation === "default") table.columns.created_at.default = "'changed'"
    if (mutation === "nullability") table.columns.name.notNull = false
    if (mutation === "missing column") delete table.columns.name
    if (mutation === "index") table.indexes.dashboard_name.isUnique = true
    if (mutation === "partial pair") delete snapshot.tables.dashboard_access_grant
    assert.throws(() => physicalSchemaShape(changed, changed.length), /Preserved dashboard migration definitions changed/)
  })
}

for (const index of [77, 146]) test(`missing or retimed ${plan[index].tag} identity fails closed`, () => {
  const changed = structuredClone(plan)
  changed[index].folderMillis++
  assert.throws(() => physicalSchemaShape(changed, changed.length), /Preserved dashboard migration definitions changed/)
  changed[index].folderMillis--
  changed[index].tag += "_changed"
  assert.throws(() => physicalSchemaShape(changed, changed.length), /Preserved dashboard migration definitions changed/)
})

test("a later SQL reference or snapshot definition requires explicit review", () => {
  const changed = structuredClone(plan)
  changed[147].sql.push("ALTER TABLE `dashboard` ADD `exp_extra` int;")
  assert.throws(() => physicalSchemaShape(changed, changed.length), /Preserved dashboard migration definitions changed/)
  changed[147].sql.pop()
  changed[147].sql.push("ALTER TABLE dashboard ADD exp_extra int;")
  assert.throws(() => physicalSchemaShape(changed, changed.length), /Preserved dashboard migration definitions changed/)
  changed[147].sql.pop()
  const snapshot = changed[147].snapshot
  assert.ok(snapshot)
  snapshot.tables.dashboard = structuredClone(creating.tables.dashboard)
  assert.throws(() => physicalSchemaShape(changed, changed.length), /Preserved dashboard migration definitions changed/)
})

test("receipt hash, timestamp and ordering guards are unchanged", () => {
  const receipts = plan.map((entry) => ({ hash: entry.hash, created_at: entry.folderMillis }))
  assert.equal(historyPrefix(plan, receipts), plan.length)
  assert.throws(() => historyPrefix(plan, [{ ...receipts[0], hash: "0".repeat(64) }]), /exact hash\/timestamp prefix/)
  assert.throws(() => historyPrefix(plan, [{ ...receipts[0], created_at: receipts[0].created_at + 1 }]), /exact hash\/timestamp prefix/)
  assert.throws(() => historyPrefix(plan, [receipts[1], receipts[0]]), /exact hash\/timestamp prefix/)
})

test("0097 source identity and empty-source guards are unchanged", async () => {
  const changed = structuredClone(plan)
  changed[96].sql[0] += "\nSELECT 1;"
  assert.throws(() => matrixPreflightQueries(changed), /0097 source changed/)
  const queries = matrixPreflightQueries(plan)
  assert.equal(queries.length, 8)
  for (const query of queries) await assert.rejects(preflightMatrix({ query: async (sql) => sql === query.sql ? [{ present: 1 }] : [] }, plan), /Preflight rejected nonempty/)
})
