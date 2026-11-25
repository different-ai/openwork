#!/usr/bin/env node
// Keeps everything derived from the preview flag registry in step with it.
//
// Every preview flag is one export in packages/features/src/previews.ts, with
// an owner and the day it expires. Keys that shipped or were cut are listed in
// packages/features/src/retired.ts.
//
//   pnpm features:sync    rewrite the chart files that are generated from the
//                         registry
//   pnpm features:check   fail if a preview breaks the registry rules (no
//                         owner, no expiry date, expired, out of order), if the
//                         capability catalog depends on a preview without
//                         saying so or names a retired one, if the chart
//                         renders different DEN_FEATURE_* names than den-api
//                         reads, if a Dockerfile misses a workspace package its
//                         service needs, or if code bypasses the registry (see
//                         below)
//   node scripts/features-sync.mjs --chart [dir]
//                         write every feature key into a chart's values.yaml and
//                         values.schema.json. The chart in git stays free of
//                         feature keys; the publish workflow runs this before
//                         `helm package`, so the published chart lists and
//                         validates every key.
//
// CI generates the Den API contract/SDK from the same feature keys.
// Read .opencode/skills/add-a-feature/SKILL.md before adding a feature.

import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkDockerWorkspacePackages } from "./check-docker-workspace-packages.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const chartDir = path.join(root, "packaging/helm/openwork-ee")
const valuesPath = path.join(chartDir, "values.yaml")
const schemaPath = path.join(chartDir, "values.schema.json")
const previewsFile = "packages/features/src/previews.ts"
const capabilityCatalogFile = "packages/managed-deployments/src/capabilities.ts"
const check = process.argv.includes("--check")
const chartFlag = process.argv.indexOf("--chart")
const chartArgument = chartFlag === -1 ? undefined : process.argv[chartFlag + 1]
/** With --chart: the chart to fill with every feature key (the repo's chart when no directory is given). */
const chartTarget = chartFlag === -1 ? null : path.resolve(chartArgument && !chartArgument.startsWith("--") ? chartArgument : chartDir)

const problems = []
const warnings = []

const BEGIN = "# BEGIN GENERATED features (pnpm features:sync; source: packages/features/src/previews.ts)"
const END = "# END GENERATED features"

// The flag files and their generated list are gone: a branch that still adds one
// has to move it, or its key would silently not exist.
for (const leftover of ["packages/features/src/flags", "packages/features/src/all-flags.ts"]) {
  if (existsSync(path.join(root, leftover))) {
    problems.push(`${leftover} is no longer read. Declare each preview in ${previewsFile} with definePreview({ ..., owner, expiresOn }) and delete ${leftover} (see .opencode/skills/add-a-feature).`)
  }
}

const {
  FEATURES,
  FEATURE_KEYS,
  RETIRED_FEATURE_KEYS,
  featureAvailableOn,
  featureLockEnvName,
} = await import("../packages/features/src/index.ts").catch((error) => {
  for (const problem of problems) console.error(`[features] ${problem}`)
  console.error(`[features] The registry does not load: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

/** Keys an operator can lock: every feature that exists on at least one deployment. */
const helmKeys = FEATURE_KEYS.filter((key) => featureAvailableOn(key, "self_hosted") || featureAvailableOn(key, "cloud"))

function defaultLabel(key) {
  const scope = featureAvailableOn(key, "self_hosted") ? "" : " (cloud only)"
  return `default ${FEATURES[key].default ? "on" : "off"}${scope}`
}

const valuesHeader = [
  `  ${BEGIN}`,
  "  # Operator locks for this install. Each key renders DEN_FEATURE_<KEY>.",
  "  #   \"\"      follow /admin: on or off for everyone, plus per-organization overrides",
  "  #   \"true\"  on for everyone; /admin shows \"Set by deployment config\"",
  "  #   \"false\" off for everyone; /admin shows \"Set by deployment config\"",
  "  # The /admin kill switch still turns a feature off, even when locked on.",
]

/** The block in a published chart: every key an operator can lock. */
function valuesBlock() {
  const width = Math.max(...helmKeys.map((key) => key.length)) + 5
  const lines = [
    ...valuesHeader,
    "  features:",
    ...helmKeys.map((key) => `    ${`${key}: ""`.padEnd(width)}# ${defaultLabel(key)} · ${FEATURES[key].description}`),
    `  ${END}`,
  ]
  return lines.join("\n")
}

/** The block kept in git: no feature keys, so adding a feature never touches the chart. */
function committedValuesBlock() {
  const lines = [
    ...valuesHeader,
    "  # The published chart lists every key here with its default and description",
    "  # (`helm show values oci://ghcr.io/different-ai/charts/openwork-ee`). In a",
    "  # checkout the keys are the exports of packages/features/src/previews.ts;",
    "  # `node scripts/features-sync.mjs --chart` writes them here.",
    "  features: {}",
    `  ${END}`,
  ]
  return lines.join("\n")
}

function renderValues(current, block) {
  const start = current.indexOf("  # BEGIN GENERATED features")
  const end = current.indexOf(`  ${END}`)
  if (start === -1 || end === -1) {
    throw new Error(`${path.relative(root, valuesPath)} is missing the generated features markers.`)
  }
  return current.slice(0, start) + block + current.slice(end + `  ${END}`.length)
}

/**
 * `full` is the published chart's schema: a key that is not a feature fails
 * `helm install`. The schema kept in git accepts any key with a valid value,
 * so adding a feature never touches it; den-api ignores unknown keys with a
 * warning.
 */
function renderSchema(full) {
  const lockValue = { enum: ["", "true", "false", true, false] }
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $comment: full
      ? "Generated by scripts/features-sync.mjs --chart from packages/features/src/previews.ts. Constrains config.deployment, config.features and config.administratorRecovery."
      : "Generated by pnpm features:sync. Constrains config.deployment, config.features and config.administratorRecovery. The published chart also rejects config.features keys that are not features.",
    type: "object",
    properties: {
      config: {
        type: "object",
        properties: {
          administratorRecovery: {
            type: "object",
            additionalProperties: false,
            properties: {
              mode: { type: "string", enum: ["check", "apply"], default: "check", description: "Only processed with the recovery feature on. Check is read-only; apply grants access." },
              expectedMembers: { type: ["integer", "null"], minimum: 0, default: null, description: "Optional active team roster count; mismatch refuses without recovery writes." },
              organization: { type: "string", default: "", description: "Organization ID or exact slug; optional only for one organization." },
              team: { type: "string", default: "", description: "Designated non-SCIM Admin team ID or exact name." },
              teams: { type: "object", additionalProperties: { type: "string", minLength: 1 }, default: {}, description: "Alternative organization ID or slug to team ID or name map." },
            },
          },
          deployment: {
            type: "string",
            enum: ["cloud", "self_hosted"],
            description: "Which product this install is. Only OpenWork Cloud sets \"cloud\". Renders DEN_DEPLOYMENT.",
          },
          features: full
            ? {
              type: "object",
              additionalProperties: false,
              properties: Object.fromEntries([
                ...helmKeys.map((key) => [key, {
                  // --set turns "true" into a boolean, so accept both spellings.
                  ...lockValue,
                  description: `${FEATURES[key].label}: ${FEATURES[key].description} Renders ${featureLockEnvName(key)}.`,
                }]),
                // Retired keys stay accepted so an upgrade with an old values file
                // still installs; den-api ignores their variables with a warning.
                ...RETIRED_FEATURE_KEYS.map((key) => [key, {
                  ...lockValue,
                  description: "Retired: no longer a feature switch. Ignored.",
                }]),
              ]),
            }
            : {
              type: "object",
              description: "Operator locks, one per feature key. Each renders DEN_FEATURE_<KEY>.",
              additionalProperties: lockValue,
            },
        },
      },
    },
  }
  return `${JSON.stringify(schema, null, 2)}\n`
}

// Features declared before internal docs were required. This list only
// shrinks: write the doc, set `docs`, and remove the key here.
const FEATURES_WITHOUT_DOCS = new Set([
  "administratorRecovery",
  "workbotDocuments",
  "workbotWorkspaceAssistant",
])

/** The internal doc exists under docs/ (not the published packages/docs) and its images resolve. */
function featureDocsProblems(key, docs) {
  if (docs === undefined) {
    return FEATURES_WITHOUT_DOCS.has(key)
      ? []
      : [`Preview flag "${key}" needs docs: an internal doc such as docs/features/${key}/README.md that explains it, with a screenshot next to it if it is visual (see .opencode/skills/add-a-feature).`]
  }
  if (FEATURES_WITHOUT_DOCS.has(key)) {
    return [`Feature "${key}" has docs now: remove it from FEATURES_WITHOUT_DOCS in scripts/features-sync.mjs.`]
  }
  if (typeof docs !== "string" || !/^docs\/.+\.md$/.test(docs) || docs.includes("..")) {
    return [`Feature "${key}" docs must be a Markdown file under docs/ (internal docs, not packages/docs), got ${JSON.stringify(docs)}.`]
  }
  const docPath = path.join(root, docs)
  let text = ""
  try {
    text = readFileSync(docPath, "utf8")
  } catch {
    return [`Feature "${key}" docs points at ${docs}, which does not exist.`]
  }
  const found = []
  for (const match of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<img\b[^>]*\bsrc=["']([^"']+)["']/g)) {
    const target = match[1] ?? match[2]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue
    const imagePath = target.startsWith("/") ? path.join(root, target) : path.join(path.dirname(docPath), decodeURIComponent(target))
    try {
      statSync(imagePath)
    } catch {
      found.push(`Feature "${key}" docs ${docs} shows ${target}, which does not exist.`)
    }
  }
  return found
}

/** Writes every feature key into a chart directory: what the published chart contains. */
function writeFullChart(directory) {
  const values = path.join(directory, "values.yaml")
  writeFileSync(values, renderValues(readFileSync(values, "utf8"), valuesBlock()))
  writeFileSync(path.join(directory, "values.schema.json"), renderSchema(true))
}

function compareOrWrite(filePath, next) {
  let current = ""
  try {
    current = readFileSync(filePath, "utf8")
  } catch {
    current = ""
  }
  if (current === next) return
  if (check) problems.push(`${path.relative(root, filePath)} is out of date. Run \`pnpm features:sync\` and commit the result. The chart in git lists no feature keys.`)
  else writeFileSync(filePath, next)
}

if (chartTarget) {
  writeFullChart(chartTarget)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[features] ${problem}`)
    process.exit(1)
  }
  console.log(`[features] Wrote ${helmKeys.length} feature keys into ${path.relative(root, chartTarget) || "."}. Do not commit them.`)
  process.exit(0)
}

compareOrWrite(valuesPath, renderValues(readFileSync(valuesPath, "utf8"), committedValuesBlock()))
compareOrWrite(schemaPath, renderSchema(false))

if (check) {
  // Registry rules: every preview has an owner and an expiry date that has not passed.
  const { previewRuleProblems, firstUnsortedKey } = await import("../packages/features/src/preview-rules.ts")
  const today = new Date().toISOString().slice(0, 10)
  for (const key of FEATURE_KEYS) {
    const found = previewRuleProblems(key, FEATURES[key], today)
    problems.push(...found.problems, ...featureDocsProblems(key, FEATURES[key].docs))
    warnings.push(...found.warnings)
  }

  // One export per preview, in alphabetical order, so two branches rarely touch the same lines.
  const declared = [...readFileSync(path.join(root, previewsFile), "utf8").matchAll(/^export const ([A-Za-z0-9_$]+) = definePreview\(/gm)].map((match) => match[1])
  for (const key of FEATURE_KEYS) {
    if (!declared.includes(key)) problems.push(`${previewsFile}: declare "${key}" as \`export const ${key} = definePreview({ ... })\` at the start of a line.`)
  }
  const unsorted = firstUnsortedKey(declared)
  if (unsorted) problems.push(`${previewsFile}: "${unsorted.key}" comes after "${unsorted.after}". Keep the exports in alphabetical order.`)

  // A key is a preview or retired, never both, and is retired once.
  const retiredSeen = new Set()
  for (const key of RETIRED_FEATURE_KEYS) {
    if (retiredSeen.has(key)) problems.push(`packages/features/src/retired.ts lists "${key}" twice.`)
    retiredSeen.add(key)
    if (FEATURE_KEYS.includes(key)) problems.push(`"${key}" is both a preview flag and retired. Delete it from ${previewsFile} when it ships or is cut.`)
  }

  // A capability works once its infrastructure is installed: it may not depend on a preview
  // without a recorded gap, or keep naming one that shipped or was cut.
  if (existsSync(path.join(root, capabilityCatalogFile))) {
    const { capabilityPreviewProblems } = await import("../packages/features/src/capability-check.ts")
    try {
      const { CAPABILITIES } = await import(`../${capabilityCatalogFile}`)
      problems.push(...capabilityPreviewProblems(CAPABILITIES, {
        previewKeys: FEATURE_KEYS,
        selfHostedKeys: FEATURE_KEYS.filter((key) => featureAvailableOn(key, "self_hosted")),
        retiredKeys: RETIRED_FEATURE_KEYS,
      }))
    } catch (error) {
      problems.push(`${capabilityCatalogFile} does not load in the feature check, so its preview dependencies cannot be verified: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // The chart must render exactly the variable names den-api reads.
  let helmAvailable = true
  try {
    execFileSync("helm", ["version", "--short"], { stdio: "ignore" })
  } catch {
    helmAvailable = false
  }
  const chartStale = problems.some((problem) => problem.includes("out of date"))
  if (helmAvailable && !chartStale) {
    // Render the chart as it is published: with every key and the strict schema.
    const published = mkdtempSync(path.join(os.tmpdir(), "openwork-features-chart-"))
    cpSync(chartDir, published, { recursive: true })
    writeFullChart(published)
    const setArgs = helmKeys.flatMap((key) => ["--set-string", `config.features.${key}=true`])
    let rendered = ""
    try {
      rendered = execFileSync("helm", ["template", "features-check", published, "--show-only", "templates/configmap.yaml", ...setArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : String(error)
      problems.push(`helm template failed with every feature key set: ${stderr.trim()}`)
    }
    try {
      execFileSync("helm", ["template", "features-check", published, "--set-string", "config.features.notAFeature=true"], { stdio: "ignore" })
      problems.push("The published chart must reject a config.features key that is not a feature.")
    } catch {
      // Rejected, as it should be.
    }
    rmSync(published, { recursive: true, force: true })
    const renderedNames = new Set([...rendered.matchAll(/^\s+(DEN_FEATURE_[A-Z0-9_]+):/gm)].map((match) => match[1]))
    for (const key of helmKeys) {
      if (!renderedNames.has(featureLockEnvName(key))) {
        problems.push(`Helm renders no ${featureLockEnvName(key)} for config.features.${key}; den-api would never see it.`)
      }
    }
    for (const name of renderedNames) {
      if (!helmKeys.some((key) => featureLockEnvName(key) === name)) problems.push(`Helm renders ${name}, which den-api does not read.`)
    }
    if (!/^\s+DEN_DEPLOYMENT: "self_hosted"$/m.test(rendered)) problems.push("Helm must render DEN_DEPLOYMENT, defaulting to self_hosted.")
  } else if (!helmAvailable) {
    console.warn("[features] helm is not installed; skipped the chart render check.")
  }

  // Images that copy workspace packages one by one must copy every one they need.
  problems.push(...checkDockerWorkspacePackages(root))

  // No new deployment-wide feature switches: declare a feature instead.
  const allowedEnableFlags = new Set([
    "DEN_APP_MCP_SERVERS_ENABLED", "DEN_AUDIT_CAPTURE_ENABLED", "DEN_AUDIT_SELF_HOSTED_ENABLED", "DEN_AUDIT_VISIBILITY_ENABLED",
    "DEN_AUTOMATIONS_ENABLED", "DEN_AUTOMATIONS_RUNTIME_ENABLED", "DEN_BOTID_PROTECTION_ENABLED", "DEN_DASHBOARDS_ENABLED",
    "DEN_GENERATED_ARTIFACT_VIEWS_ENABLED", "DEN_OPENWORK_WEB_ENABLED", "DEN_PASSWORD_BREACH_SCREENING_ENABLED",
    "DEN_PLAN_GATING_ENABLED", "DEN_SLACK_ASSISTANT_WORKER_ENABLED",
  ])

  function* sourceFiles(dir) {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === "drizzle" || entry === "gen") continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) yield* sourceFiles(full)
      else if (/\.(ts|tsx|mjs)$/.test(entry)) yield full
    }
  }

  // Feature overrides live in the organization_feature table; only the store
  // (and the one-release rollback copy) may touch metadata.capabilities.
  const metadataCapabilitiesAllowed = new Set([
    "ee/packages/den-db/src/organization-features.ts",
    "ee/apps/den-api/src/orgs.ts",
  ])

  for (const dir of ["ee/apps/den-api/src", "ee/apps/den-web/app", "ee/apps/den-web/components", "ee/apps/gateway/src", "ee/packages", "apps/app/src", "apps/server/src"]) {
    const absolute = path.join(root, dir)
    try {
      statSync(absolute)
    } catch {
      continue
    }
    for (const file of sourceFiles(absolute)) {
      const relative = path.relative(root, file)
      const text = readFileSync(file, "utf8")
      if (relative.startsWith("ee/apps/den-api/src")) {
        for (const match of text.matchAll(/\bDEN_[A-Z0-9_]+_ENABLED\b/g)) {
          if (!allowedEnableFlags.has(match[0])) {
            problems.push(`${relative}: new switch ${match[0]}. Declare a preview flag in packages/features/src/previews.ts instead (see .opencode/skills/add-a-feature).`)
          }
        }
      }
      if (!metadataCapabilitiesAllowed.has(relative) && /metadata\)?\??\.capabilities\b|\$\.capabilities/.test(text)) {
        problems.push(`${relative}: reads organization metadata.capabilities. Use getOrganizationFeatures() / orgFeatureEnabled() instead.`)
      }
    }
  }
}

for (const warning of [...new Set(warnings)]) console.warn(`[features] ${warning}`)
if (problems.length > 0) {
  for (const problem of [...new Set(problems)]) console.error(`[features] ${problem}`)
  process.exit(1)
}
console.log(check ? "[features] Preview flags, Helm chart and guard rules are in sync." : "[features] Chart files are up to date.")
