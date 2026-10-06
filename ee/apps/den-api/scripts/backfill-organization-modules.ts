import { writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { db } from "../src/db.js"
import { env } from "../src/env.js"
import { runOrganizationModulesBackfill, type BackfillMode } from "../src/organization-modules-backfill.js"

const usage = `Usage: pnpm --filter @openwork-ee/den-api backfill:organization-modules -- [options]

  --dry-run           Compute and report; write nothing.
  --verify            Compare stored documents with organization_feature overrides; exit 1 on any mismatch.
  --repair            With a real run, replace documents that fail validation.
  --batch-size <n>    Rows per page (default 500).
  --org <id>          Limit to one organization (repeatable).
  --report <path>     Also write the JSON report to this path.`

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    verify: { type: "boolean", default: false },
    repair: { type: "boolean", default: false },
    "batch-size": { type: "string" },
    org: { type: "string", multiple: true },
    report: { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  console.log(usage)
  process.exit(0)
}
if (values["dry-run"] && values.verify) {
  console.error("Choose either --dry-run or --verify.")
  process.exit(2)
}

const batchSize = values["batch-size"] === undefined ? 500 : Number.parseInt(values["batch-size"], 10)
if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
  console.error("--batch-size must be a positive integer.")
  process.exit(2)
}

const mode: BackfillMode = values.verify ? "verify" : values["dry-run"] ? "dry-run" : "write"
const report = await runOrganizationModulesBackfill(db, {
  mode,
  featureEnvironment: env.features,
  repair: values.repair,
  batchSize,
  organizationIds: values.org,
})

const summary = {
  mode: report.mode,
  scanned: report.scanned,
  written: report.written,
  wouldWrite: report.wouldWrite,
  nothingToCopy: report.nothingToCopy,
  alreadyPresent: report.alreadyPresent,
  invalidDocument: report.invalidDocument,
  repaired: report.repaired,
  skippedConcurrent: report.skippedConcurrent,
  disabledByModule: report.disabledByModule,
  divergenceChecks: report.divergenceChecks,
  verifyMismatches: report.verifyMismatches.length,
}
console.log(JSON.stringify(summary, null, 2))
if (values.report) await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`)

process.exit(mode === "verify" && report.verifyMismatches.length > 0 ? 1 : 0)
