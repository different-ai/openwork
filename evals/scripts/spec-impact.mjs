import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const defaultSnapshot = resolve(repoRoot, "evals/specs/contracts.snapshot.json")

function matches(pathname, pattern) {
  if (pattern.endsWith("/**")) return pathname.startsWith(pattern.slice(0, -3))
  return pathname === pattern
}

function strings(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${label} must be a non-empty string array`)
  }
  return value
}

export function validateSnapshot(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("snapshot must be an object")
  if (Reflect.get(value, "version") !== 1) throw new Error("snapshot version must be 1")
  const rawContracts = Reflect.get(value, "contracts")
  if (!Array.isArray(rawContracts) || rawContracts.length === 0) throw new Error("snapshot contracts must be a non-empty array")
  const ids = new Set()
  const contracts = rawContracts.map((contract, index) => {
    if (typeof contract !== "object" || contract === null || Array.isArray(contract)) {
      throw new Error(`contracts[${index}] must be an object`)
    }
    const id = Reflect.get(contract, "id")
    const description = Reflect.get(contract, "description")
    if (typeof id !== "string" || id.length === 0) throw new Error(`contracts[${index}].id must be a string`)
    if (ids.has(id)) throw new Error(`duplicate contract id: ${id}`)
    ids.add(id)
    if (typeof description !== "string" || description.length === 0) {
      throw new Error(`contracts[${index}].description must be a string`)
    }
    return {
      id,
      description,
      implementation: strings(Reflect.get(contract, "implementation"), `${id}.implementation`),
      specs: strings(Reflect.get(contract, "specs"), `${id}.specs`),
    }
  })
  const rawUnmapped = Reflect.get(value, "unmapped")
  if (rawUnmapped !== undefined) {
    if (!Array.isArray(rawUnmapped)) throw new Error("snapshot unmapped must be an array")
    const unmappedSpecs = new Set()
    const mappedSpecs = new Set(contracts.flatMap((contract) => contract.specs))
    rawUnmapped.forEach((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`unmapped[${index}] must be an object`)
      }
      const spec = Reflect.get(entry, "spec")
      const reason = Reflect.get(entry, "reason")
      if (typeof spec !== "string" || spec.length === 0) throw new Error(`unmapped[${index}].spec must be a non-empty string`)
      if (typeof reason !== "string" || reason.length === 0) throw new Error(`unmapped[${index}].reason must be a non-empty string`)
      if (unmappedSpecs.has(spec)) throw new Error(`duplicate unmapped spec: ${spec}`)
      if (mappedSpecs.has(spec)) throw new Error(`unmapped spec is also mapped by a contract: ${spec}`)
      unmappedSpecs.add(spec)
    })
  }
  return contracts
}

export function analyzeImpact(contracts, changedFiles) {
  const changed = [...new Set(changedFiles.map((entry) => entry.trim()).filter(Boolean))].sort()
  const changedE2eTests = changed.filter((pathname) => pathname.startsWith("evals/specs/") && pathname.endsWith(".e2e.test.ts"))
  const impacted = contracts.flatMap((contract) => {
    const implementation = changed.filter((pathname) => contract.implementation.some((pattern) => matches(pathname, pattern)))
    if (implementation.length === 0) return []
    const specs = changed.filter((pathname) => contract.specs.includes(pathname))
    return [{ ...contract, changedImplementation: implementation, changedSpecs: specs, covered: specs.length > 0 }]
  })
  return {
    changed,
    changedE2eTests,
    impacted,
    attention: impacted.filter((contract) => !contract.covered),
    matchedTests: [...new Set([...impacted.flatMap((contract) => contract.specs), ...changedE2eTests])].sort(),
  }
}

function markdown(result) {
  const lines = ["### Soft spec-impact snapshot", ""]
  if (result.impacted.length === 0) {
    lines.push(
      "No mapped implementation contract changed.",
      "Warden suggestion: add or update an `evals/specs/<feature>.e2e.test.ts` test for this change if it affects app behavior.",
      "",
    )
    return lines.join("\n")
  }
  lines.push("| Contract | Result | Changed implementation | Mapped E2E tests |", "| --- | --- | --- | --- |")
  for (const contract of result.impacted) {
    const status = contract.covered ? "Covered by a changed E2E test" : "Needs attention"
    const implementation = contract.changedImplementation.map((entry) => `\`${entry}\``).join("<br>")
    const specs = contract.specs.map((entry) => `\`${entry}\``).join("<br>")
    lines.push(`| \`${contract.id}\` | ${status} | ${implementation} | ${specs} |`)
  }
  lines.push("")
  if (result.attention.length > 0) {
    lines.push("This check is advisory: confirm the existing mapped E2E test still proves the contract, or update/add an E2E test.", "")
  }
  lines.push(`Matched E2E tests: ${result.matchedTests.map((test) => `\`${test}\``).join(", ") || "none"}`, "")
  return lines.join("\n")
}

function annotation(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")
}

function parseArgs(args) {
  const options = { changedFiles: [] }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--strict") options.strict = true
    else if (argument === "--json") options.json = true
    else if (argument === "--matched-tests") options.matchedTests = true
    else if (["--base", "--head", "--snapshot", "--summary", "--changed-file"].includes(argument)) {
      const value = args[index + 1]
      if (!value) throw new Error(`${argument} requires a value`)
      index += 1
      if (argument === "--changed-file") options.changedFiles.push(value)
      else options[argument.slice(2)] = value
    } else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

function gitChangedFiles(base, head) {
  if (!base || !head) throw new Error("pass both --base and --head, or one or more --changed-file values")
  return execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${base}...${head}`], {
    cwd: repoRoot,
    encoding: "utf8",
  }).split("\n").filter(Boolean)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const snapshotPath = resolve(repoRoot, options.snapshot ?? defaultSnapshot)
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"))
  const contracts = validateSnapshot(snapshot)
  const changedFiles = options.changedFiles.length > 0
    ? options.changedFiles
    : gitChangedFiles(options.base, options.head)
  const result = analyzeImpact(contracts, changedFiles)
  const report = markdown(result)
  if (options.summary) appendFileSync(options.summary, report)
  if (options.matchedTests) {
    process.stdout.write(`${JSON.stringify(result.matchedTests)}\n`)
    return
  }
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else process.stdout.write(report)
  for (const contract of result.attention) {
    process.stdout.write(`::warning title=Spec impact snapshot::${annotation(`${contract.id} changed without a mapped E2E test change`)}\n`)
  }
  if (options.strict && result.attention.length > 0) process.exitCode = 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
