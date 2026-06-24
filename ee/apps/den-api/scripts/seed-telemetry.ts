// Seed realistic 12-week telemetry for the demo org so analytics charts populate.
// Run like seed-demo-org: tsx scripts/seed-telemetry.ts
import { eq } from "@openwork-ee/den-db/drizzle"
import { MemberTable, OrganizationTable, TelemetryEventTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../src/db.js"

const org = (await db.select().from(OrganizationTable).limit(1))[0]
if (!org) {
  console.error("No organization found")
  process.exit(1)
}
const members = await db.select().from(MemberTable).where(eq(MemberTable.org_id, org.id))
if (members.length === 0) {
  console.error("No members found")
  process.exit(1)
}
console.log(`Seeding telemetry for org ${org.id} with ${members.length} members`)

// Clear prior seeded telemetry for a clean, deterministic chart.
await db.delete(TelemetryEventTable).where(eq(TelemetryEventTable.org_id, org.id))

const now = Date.now()
const WEEK = 7 * 24 * 60 * 60 * 1000
const rows: (typeof TelemetryEventTable.$inferInsert)[] = []

// Growth curve over 12 weeks (oldest -> newest).
const activeCurve = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
const sessionsCurve = [6, 9, 11, 14, 18, 22, 26, 30, 34, 39, 44, 50]
const tasksCurve = [10, 14, 18, 24, 30, 38, 46, 55, 64, 74, 85, 96]

let sessionCounter = 0
for (let w = 0; w < 12; w++) {
  // weekStart = (11 - w) weeks ago ... newest week is w=11
  const weekAgo = 11 - w
  const weekBase = now - weekAgo * WEEK
  const ts = (offsetWithinWeek: number) =>
    new Date(weekBase + Math.min(offsetWithinWeek, WEEK - 60_000))

  const activeN = Math.min(activeCurve[w], members.length)
  for (let m = 0; m < activeN; m++) {
    rows.push({
      id: createDenTypeId("telemetryEvent"),
      org_id: org.id,
      member_id: members[m % members.length].id,
      event_type: "user.active",
      event_timestamp: ts(m * 3600_000 + 3600_000),
      source: "app",
      session_id: null,
      duration_ms: null,
      success: null,
    })
  }

  const sessionsN = sessionsCurve[w]
  for (let s = 0; s < sessionsN; s++) {
    sessionCounter++
    rows.push({
      id: createDenTypeId("telemetryEvent"),
      org_id: org.id,
      member_id: members[s % members.length].id,
      event_type: "session.started",
      event_timestamp: ts(s * 600_000 + 600_000),
      source: "app",
      session_id: `seed-sess-${sessionCounter}`,
      duration_ms: null,
      success: null,
    })
  }

  const tasksN = tasksCurve[w]
  const failures = Math.max(1, Math.round(tasksN * 0.04))
  for (let t = 0; t < tasksN; t++) {
    const failed = t < failures
    rows.push({
      id: createDenTypeId("telemetryEvent"),
      org_id: org.id,
      member_id: members[t % members.length].id,
      event_type: failed ? "task.failed" : "task.completed",
      event_timestamp: ts(t * 300_000 + 300_000),
      source: "app",
      session_id: `seed-sess-${(sessionCounter % sessionsN) + 1}`,
      duration_ms: failed ? null : 3000 + Math.round(Math.random() * 12000),
      success: failed ? false : true,
    })
  }
}

// Bulk insert in chunks.
for (let i = 0; i < rows.length; i += 200) {
  await db.insert(TelemetryEventTable).values(rows.slice(i, i + 200))
}
console.log(`Inserted ${rows.length} telemetry events across 12 weeks.`)
process.exit(0)
