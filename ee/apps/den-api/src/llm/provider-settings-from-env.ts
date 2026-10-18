/**
 * Bind namespaced non-secret settings into SDK `options` so Bedrock/Azure
 * work after LPR_/IPR_ env namespacing (#4281 / #4922).
 * Kept in sync with apps/server/src/provider-settings-from-env.ts (server cannot
 * import @openwork-ee/utils).
 */

type JsonRecord = Record<string, unknown>

const BEDROCK_NPMS = new Set(["@ai-sdk/amazon-bedrock", "@ai-sdk/amazon-bedrock/mantle"])
const AZURE_NPM = "@ai-sdk/azure"

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isAwsRegion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/.test(value)
}

function envValue(
  envEntries: ReadonlyArray<{ key: string; value: string }>,
  suffixPattern: RegExp,
): string | null {
  for (const entry of envEntries) {
    if (!suffixPattern.test(entry.key)) continue
    const trimmed = entry.value.trim()
    if (trimmed) return trimmed
  }
  return null
}

export function withProviderSettingsFromEnv(
  config: JsonRecord,
  envEntries: ReadonlyArray<{ key: string; value: string }>,
): JsonRecord {
  const npm = typeof config.npm === "string" ? config.npm : null
  if (!npm) return config

  const options = isRecord(config.options) ? { ...config.options } : {}
  let changed = false

  if (BEDROCK_NPMS.has(npm)) {
    const region = envValue(envEntries, /(?:^|_)AWS_REGION$/)
    if (region && isAwsRegion(region) && options.region !== region) {
      options.region = region
      changed = true
    }
  }

  if (npm === AZURE_NPM) {
    const resourceName = envValue(envEntries, /(?:^|_)AZURE_RESOURCE_NAME$/)
    if (resourceName && options.resourceName !== resourceName) {
      options.resourceName = resourceName
      changed = true
    }
  }

  return changed ? { ...config, options } : config
}
