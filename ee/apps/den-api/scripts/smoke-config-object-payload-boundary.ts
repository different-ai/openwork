#!/usr/bin/env tsx
/**
 * Smoke test for the config-object version payload boundary against a deployed Den API.
 *
 * Required env (env only; never hardcode secrets):
 *   DEN_API_BASE_URL       Den API root that serves /v1, e.g. https://app.openworklabs.com/api/den
 *   DEN_API_BEARER_TOKEN   Bearer token from an authenticated Den session with config-object edit access
 *   DEN_CONFIG_OBJECT_ID   Explicit target configObjectId (cob_...) to receive new immutable versions
 *
 * Usage:
 *   DEN_API_BASE_URL=https://app.openworklabs.com/api/den \
 *   DEN_API_BEARER_TOKEN=<session bearer token> \
 *   DEN_CONFIG_OBJECT_ID=cob_... \
 *   pnpm --filter @openwork-ee/den-api run smoke:config-object-payload-boundary -- --dry-run
 *
 * Safety: this script only creates new versions for the named config object. It does not delete,
 * mutate schema, or modify other config objects. Use --dry-run to print the probe plan without writes.
 */

type ExpectedStatus = 201 | 400
type ProbeField = "rawSourceText" | "normalizedPayloadJson"
type Verdict = "DRY-RUN" | "FAIL" | "PASS"

type EnvDoc = {
  description: string
  name: string
}

type SmokeConfig = {
  baseUrl: string
  bearerToken: string
  configObjectId: string
}

type ConfigObjectInput = {
  normalizedPayloadJson?: Record<string, unknown>
  rawSourceText?: string
}

type ProbePlan = {
  buildInput: () => ConfigObjectInput
  expectedStatus: ExpectedStatus
  field: ProbeField
  label: string
  measuredBytes: number
  requestedPlaintextBytes: number
  sourcePayloadBytes: number
}

type ProbeResult = ProbePlan & {
  actualStatus: number
  responseBody?: string
  verdict: "FAIL" | "PASS"
}

type ProbeDefinition = {
  expectedStatus: ExpectedStatus
  label: string
  requestedPlaintextBytes: number
}

const OLD_MYSQL_TEXT_PLAINTEXT_CEILING_BYTES = 49_113
const CONFIG_OBJECT_INPUT_MAX_PAYLOAD_BYTES = 1_048_576
const SMOKE_REASON = "smoke: config object payload boundary check"

const requiredEnv: EnvDoc[] = [
  {
    name: "DEN_API_BASE_URL",
    description: "Use the deployed Den API root that serves /v1, for example https://app.openworklabs.com/api/den.",
  },
  {
    name: "DEN_API_BEARER_TOKEN",
    description: "Sign in to the target Den environment as an operator with edit access and copy the session bearer token from an authenticated request. The token is never printed.",
  },
  {
    name: "DEN_CONFIG_OBJECT_ID",
    description: "Choose the explicit config object to version and copy its cob_... id from the config object detail/API response.",
  },
]

const rawSourceTextProbeDefinitions: ProbeDefinition[] = [
  {
    label: "old MySQL TEXT plaintext ceiling",
    requestedPlaintextBytes: OLD_MYSQL_TEXT_PLAINTEXT_CEILING_BYTES,
    expectedStatus: 201,
  },
  {
    label: "one byte past old ceiling / errno 1406 regression",
    requestedPlaintextBytes: OLD_MYSQL_TEXT_PLAINTEXT_CEILING_BYTES + 1,
    expectedStatus: 201,
  },
  {
    label: "comfortably past old ceiling",
    requestedPlaintextBytes: 200_000,
    expectedStatus: 201,
  },
  {
    label: "exact validation limit",
    requestedPlaintextBytes: CONFIG_OBJECT_INPUT_MAX_PAYLOAD_BYTES,
    expectedStatus: 201,
  },
  {
    label: "one byte over validation limit",
    requestedPlaintextBytes: CONFIG_OBJECT_INPUT_MAX_PAYLOAD_BYTES + 1,
    expectedStatus: 400,
  },
]

const normalizedPayloadJsonProbeDefinitions: ProbeDefinition[] = [
  {
    label: "JSON.stringify(value) exact validation limit",
    requestedPlaintextBytes: CONFIG_OBJECT_INPUT_MAX_PAYLOAD_BYTES,
    expectedStatus: 201,
  },
  {
    label: "JSON.stringify(value) one byte over validation limit",
    requestedPlaintextBytes: CONFIG_OBJECT_INPUT_MAX_PAYLOAD_BYTES + 1,
    expectedStatus: 400,
  },
]

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8")
}

function requireExactBytes(input: { actualBytes: number; expectedBytes: number; label: string }) {
  if (input.actualBytes !== input.expectedBytes) {
    throw new Error(`${input.label} generated ${input.actualBytes} bytes, expected ${input.expectedBytes}.`)
  }
}

function jsonStringifyObject(value: Record<string, unknown>) {
  const stringified = JSON.stringify(value)
  if (typeof stringified !== "string") {
    throw new Error("Expected normalizedPayloadJson probe value to stringify to JSON text.")
  }
  return stringified
}

function makeRawSourceText(sizeBytes: number) {
  const rawSourceText = "a".repeat(sizeBytes)
  requireExactBytes({
    actualBytes: utf8Bytes(rawSourceText),
    expectedBytes: sizeBytes,
    label: `rawSourceText ${sizeBytes}`,
  })
  return rawSourceText
}

function makeNormalizedPayloadJson(targetStringifiedBytes: number) {
  const emptyPayloadBytes = utf8Bytes(jsonStringifyObject({ payload: "" }))
  let remainingBytes = targetStringifiedBytes - emptyPayloadBytes
  if (remainingBytes < 0) {
    throw new Error(`normalizedPayloadJson target ${targetStringifiedBytes} is smaller than empty object overhead ${emptyPayloadBytes}.`)
  }

  const quoteNewlinePairs = Math.floor(remainingBytes / 4)
  let payload = "\"\n".repeat(quoteNewlinePairs)
  remainingBytes -= quoteNewlinePairs * 4

  if (remainingBytes >= 2) {
    payload += "\""
    remainingBytes -= 2
  }

  if (remainingBytes === 1) {
    payload += "a"
    remainingBytes -= 1
  }

  if (remainingBytes !== 0) {
    throw new Error(`Failed to generate normalizedPayloadJson payload with ${targetStringifiedBytes} stringified bytes.`)
  }

  const value = { payload }
  const stringifiedBytes = utf8Bytes(jsonStringifyObject(value))
  requireExactBytes({
    actualBytes: stringifiedBytes,
    expectedBytes: targetStringifiedBytes,
    label: `normalizedPayloadJson ${targetStringifiedBytes}`,
  })

  return {
    sourcePayloadBytes: utf8Bytes(payload),
    stringifiedBytes,
    value,
  }
}

function rawSourceTextPlan(definition: ProbeDefinition): ProbePlan {
  const rawSourceText = makeRawSourceText(definition.requestedPlaintextBytes)
  return {
    buildInput: () => ({ rawSourceText: makeRawSourceText(definition.requestedPlaintextBytes) }),
    expectedStatus: definition.expectedStatus,
    field: "rawSourceText",
    label: definition.label,
    measuredBytes: utf8Bytes(rawSourceText),
    requestedPlaintextBytes: definition.requestedPlaintextBytes,
    sourcePayloadBytes: utf8Bytes(rawSourceText),
  }
}

function normalizedPayloadJsonPlan(definition: ProbeDefinition): ProbePlan {
  const payload = makeNormalizedPayloadJson(definition.requestedPlaintextBytes)
  return {
    buildInput: () => ({ normalizedPayloadJson: makeNormalizedPayloadJson(definition.requestedPlaintextBytes).value }),
    expectedStatus: definition.expectedStatus,
    field: "normalizedPayloadJson",
    label: definition.label,
    measuredBytes: payload.stringifiedBytes,
    requestedPlaintextBytes: definition.requestedPlaintextBytes,
    sourcePayloadBytes: payload.sourcePayloadBytes,
  }
}

function buildProbePlans() {
  return [
    ...rawSourceTextProbeDefinitions.map(rawSourceTextPlan),
    ...normalizedPayloadJsonProbeDefinitions.map(normalizedPayloadJsonPlan),
  ]
}

function envValue(name: string) {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function usageLines() {
  return [
    "Usage:",
    "  DEN_API_BASE_URL=<deployed Den API root> \\",
    "  DEN_API_BEARER_TOKEN=<session bearer token> \\",
    "  DEN_CONFIG_OBJECT_ID=cob_... \\",
    "  pnpm --filter @openwork-ee/den-api run smoke:config-object-payload-boundary -- [--dry-run]",
  ]
}

function printUsage() {
  for (const line of usageLines()) console.log(line)
}

function printUsageError() {
  for (const line of usageLines()) console.error(line)
}

function printMissingEnv(missing: EnvDoc[]) {
  console.error("[smoke] Missing required environment variables:")
  for (const item of missing) {
    console.error(`  - ${item.name}: ${item.description}`)
  }
  console.error("")
  printUsageError()
  console.error("")
  console.error("DEN_API_BEARER_TOKEN is intentionally not printed by this script.")
}

function readConfig(): SmokeConfig | null {
  const missing = requiredEnv.filter((item) => !envValue(item.name))
  if (missing.length > 0) {
    printMissingEnv(missing)
    return null
  }

  const baseUrl = envValue("DEN_API_BASE_URL")
  const bearerToken = envValue("DEN_API_BEARER_TOKEN")
  const configObjectId = envValue("DEN_CONFIG_OBJECT_ID")
  if (!baseUrl || !bearerToken || !configObjectId) {
    printMissingEnv(requiredEnv)
    return null
  }

  try {
    new URL(baseUrl)
  } catch {
    console.error("[smoke] DEN_API_BASE_URL must be a valid URL that serves /v1.")
    return null
  }

  if (!configObjectId.startsWith("cob_")) {
    console.error(`[smoke] DEN_CONFIG_OBJECT_ID must start with cob_; received ${configObjectId}.`)
    return null
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    bearerToken,
    configObjectId,
  }
}

function configObjectVersionsUrl(config: SmokeConfig) {
  return `${config.baseUrl}/v1/config-objects/${encodeURIComponent(config.configObjectId)}/versions`
}

function printWarning(input: { config: SmokeConfig; dryRun: boolean; plans: ProbePlan[] }) {
  console.log("[smoke] WARNING: this script writes new immutable versions to the named config object.")
  console.log(`[smoke] Target Den API base URL: ${input.config.baseUrl}`)
  console.log(`[smoke] Target configObjectId: ${input.config.configObjectId}`)
  console.log(`[smoke] Planned version creations: ${input.plans.length} (dry-run=${input.dryRun ? "true" : "false"}; writes issued=${input.dryRun ? 0 : input.plans.length})`)
  console.log(`[smoke] Version reason/source_revision_ref: ${SMOKE_REASON}`)
  if (input.dryRun) {
    console.log("[smoke] --dry-run set: printing the plan only; no HTTP writes will be issued.")
  } else {
    console.log("[smoke] No deletes, schema changes, or config-object mutations besides additive version creation are performed.")
  }
  console.log("")
}

function tableLine(row: string[], widths: number[]) {
  return row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ")
}

function printTable(input: { rows: string[][]; title: string }) {
  const headers = [
    "field",
    "case",
    "requested plaintext bytes",
    "measured bytes",
    "source payload bytes",
    "expected status",
    "actual status",
    "verdict",
  ]
  const widths = headers.map((header, index) => Math.max(header.length, ...input.rows.map((row) => row[index]?.length ?? 0)))
  console.log(input.title)
  console.log(tableLine(headers, widths))
  console.log(tableLine(headers.map((header) => "-".repeat(header.length)), widths))
  for (const row of input.rows) {
    console.log(tableLine(row, widths))
  }
  console.log("")
}

function planRow(plan: ProbePlan, actualStatus: string, verdict: Verdict) {
  return [
    plan.field,
    plan.label,
    String(plan.requestedPlaintextBytes),
    String(plan.measuredBytes),
    String(plan.sourcePayloadBytes),
    String(plan.expectedStatus),
    actualStatus,
    verdict,
  ]
}

function printPlanTable(plans: ProbePlan[]) {
  printTable({
    title: "[smoke] Probe plan",
    rows: plans.map((plan) => planRow(plan, "-", "DRY-RUN")),
  })
}

function printResultTable(results: ProbeResult[]) {
  printTable({
    title: "[smoke] Probe results",
    rows: results.map((result) => planRow(result, String(result.actualStatus), result.verdict)),
  })
}

async function postProbe(input: { config: SmokeConfig; plan: ProbePlan }): Promise<ProbeResult> {
  const response = await fetch(configObjectVersionsUrl(input.config), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.config.bearerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: input.plan.buildInput(),
      reason: SMOKE_REASON,
    }),
  })

  let responseBody: string | undefined
  if (response.status >= 500 || (response.status !== input.plan.expectedStatus && response.status !== 201)) {
    responseBody = await response.text()
  }

  return {
    ...input.plan,
    actualStatus: response.status,
    responseBody,
    verdict: response.status === input.plan.expectedStatus ? "PASS" : "FAIL",
  }
}

function printFailureDetails(results: ProbeResult[]) {
  for (const result of results) {
    if (result.verdict === "PASS") continue
    console.error(`[smoke] FAIL ${result.field} ${result.requestedPlaintextBytes} bytes: expected ${result.expectedStatus}, got ${result.actualStatus}.`)
    if (result.responseBody !== undefined) {
      console.error("[smoke] Response body:")
      console.error(result.responseBody)
    } else if (result.actualStatus === 201) {
      console.error("[smoke] Response body omitted because successful responses may echo the submitted large payload.")
    }
  }
}

async function runProbes(input: { config: SmokeConfig; plans: ProbePlan[] }) {
  const results: ProbeResult[] = []
  for (const plan of input.plans) {
    console.log(`[smoke] POST ${plan.field} ${plan.requestedPlaintextBytes} bytes; expecting ${plan.expectedStatus}`)
    results.push(await postProbe({ config: input.config, plan }))
  }
  console.log("")
  return results
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--help")) {
    printUsage()
    return 0
  }

  const unknownArgs = args.filter((arg) => arg !== "--" && arg !== "--dry-run")
  if (unknownArgs.length > 0) {
    console.error(`[smoke] Unknown argument(s): ${unknownArgs.join(", ")}`)
    printUsage()
    return 1
  }

  const config = readConfig()
  if (!config) return 1

  const dryRun = args.includes("--dry-run")
  const plans = buildProbePlans()
  printWarning({ config, dryRun, plans })
  printPlanTable(plans)

  if (dryRun) return 0

  const results = await runProbes({ config, plans })
  printResultTable(results)
  const failed = results.some((result) => result.verdict === "FAIL")
  if (failed) {
    printFailureDetails(results)
    return 1
  }

  console.log("[smoke] PASS: config-object payload boundary matches expectations.")
  return 0
}

main()
  .then((exitCode) => process.exit(exitCode))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
