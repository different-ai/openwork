import { createDenDb } from "@openwork-ee/den-db"

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. Dry-run checks only run from the prod-data-dry-run workflow.`)
  return value
}

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

export function dryRunWritable() {
  return process.env.DRY_RUN_WRITABLE === "1"
}

const lines: string[] = []
let failed = false

export function report(label: string, value: number | boolean) {
  lines.push(`- ${label}: ${typeof value === "boolean" ? (value ? "yes" : "no") : value}`)
}

export function fail(reason: string) {
  failed = true
  lines.push(`- FAILED: ${reason}`)
}

export function finish(title: string) {
  console.log(`### ${title}\n`)
  console.log(lines.join("\n"))
  console.log(`\n${failed ? "Result: failed" : "Result: passed"}`)
  process.exitCode = failed ? 1 : 0
}
