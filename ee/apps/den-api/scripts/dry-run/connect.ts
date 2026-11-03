/**
 * Shared setup for dry-run checks (.github/workflows/prod-data-dry-run.yml).
 *
 * A check runs against a short-lived PlanetScale branch restored from the
 * latest production backup. The repository is public, so everything a check
 * prints is public: report aggregates and pass/fail only, never rows, names,
 * ids or emails. `report` enforces the shape: a label and a number or boolean.
 */
import { createDenDb } from "@openwork-ee/den-db"

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. Dry-run checks only run from the prod-data-dry-run workflow.`)
  return value
}

/** The restored branch, through Den's own database client and schema. */
export function dryRunDb() {
  if (process.env.DRY_RUN !== "1") throw new Error("Refusing to run outside the dry-run workflow (DRY_RUN=1).")
  return createDenDb({
    mode: "planetscale",
    planetscale: {
      host: required("DRY_RUN_DATABASE_HOST"),
      username: required("DRY_RUN_DATABASE_USERNAME"),
      password: required("DRY_RUN_DATABASE_PASSWORD"),
    },
  })
}

/** Whether the check was given a read-write password (migration checks only). */
export function dryRunWritable() {
  return process.env.DRY_RUN_WRITABLE === "1"
}

const lines: string[] = []
let failed = false

/** One aggregate result line: a label and a count or yes/no. Nothing else is printed. */
export function report(label: string, value: number | boolean) {
  lines.push(`- ${label}: ${typeof value === "boolean" ? (value ? "yes" : "no") : value}`)
}

/** Marks the check failed with a short reason (no data). */
export function fail(reason: string) {
  failed = true
  lines.push(`- FAILED: ${reason}`)
}

/** Prints the summary as Markdown and sets the exit code. */
export function finish(title: string) {
  console.log(`### ${title}\n`)
  console.log(lines.join("\n"))
  console.log(`\n${failed ? "Result: failed" : "Result: passed"}`)
  process.exitCode = failed ? 1 : 0
}
