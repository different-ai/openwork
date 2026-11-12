import { z } from "zod"
import { gcpBundleUrlSchema } from "@openwork/managed-deployments/gcp"

const httpsUrl = z.string().url().refine((value) => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === "https:" && !url.username && !url.password && !url.hash
})
const releaseSchema = z.object({
  templateUrl: httpsUrl,
  bundleUrl: httpsUrl,
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  apiOrigin: z.string().url().refine((value) => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1"
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback)) && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash
  }).transform((value) => new URL(value).origin),
})
export type ManagedDeploymentRelease = z.infer<typeof releaseSchema>
type Provider = "aws" | "gcp"
const gcpReleaseSchema = releaseSchema.extend({ bundleUrl: gcpBundleUrlSchema, templateUrl: gcpBundleUrlSchema })
const schemaFor = (provider: Provider) => provider === "gcp" ? gcpReleaseSchema : releaseSchema

// Automatic promotion changes one complete coordinate set, never four separate
// env fields. Executable artifacts remain pinned to immutable object versions.
const awsVersionedUrl = httpsUrl.refine((value) => {
  const url = new URL(value)
  const versions = url.searchParams.getAll("versionId")
  return /^[a-z0-9][a-z0-9.-]*\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)
    && !url.port && versions.length === 1 && Boolean(versions[0]?.trim()) && versions[0] !== "null"
    && [...url.searchParams.keys()].every((key) => key === "versionId")
}, "Use an immutable regional S3 object version URL.")
const stableVersion = z.string().max(80).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
const atomicCoordinates = releaseSchema.omit({ apiOrigin: true }).extend({ version: stableVersion }).strict()
const atomicSchemaFor = (provider: Provider) => provider === "gcp"
  ? atomicCoordinates.extend({ templateUrl: gcpBundleUrlSchema, bundleUrl: gcpBundleUrlSchema })
  : atomicCoordinates.extend({ templateUrl: awsVersionedUrl, bundleUrl: awsVersionedUrl })

/** Public release coordinates, not feature switches or credentials. */
function releaseInput(provider: Provider, environment: NodeJS.ProcessEnv) {
  const prefix = `DEN_MANAGED_DEPLOYMENT_${provider.toUpperCase()}`
  return {
    templateUrl: environment[`${prefix}_TEMPLATE_URL`],
    bundleUrl: environment[`${prefix}_BUNDLE_URL`],
    bundleSha256: environment[`${prefix}_BUNDLE_SHA256`],
    version: environment[`${prefix}_VERSION`],
    apiOrigin: environment.DEN_API_PUBLIC_URL,
  }
}

function atomicRelease(provider: Provider, environment: NodeJS.ProcessEnv) {
  const field = `DEN_MANAGED_DEPLOYMENT_${provider.toUpperCase()}_RELEASE`
  const serialized = environment[field]
  if (serialized === undefined) return null
  let input: unknown
  try {
    input = JSON.parse(serialized)
  } catch {
    input = null
  }
  const coordinates = atomicSchemaFor(provider).safeParse(input)
  const origin = releaseSchema.shape.apiOrigin.safeParse(environment.DEN_API_PUBLIC_URL)
  const release = coordinates.success && origin.success ? { ...coordinates.data, apiOrigin: origin.data } : null
  return {
    release,
    readiness: {
      provider,
      available: release !== null,
      version: release?.version ?? null,
      reason: release ? "ready" : "invalid_configuration",
      // Never return parser errors or values: URLs may contain private config.
      missingFields: [...(coordinates.success ? [] : [field]), ...(origin.success ? [] : ["DEN_API_PUBLIC_URL"])],
    },
  }
}

export function releaseReadiness(provider: Provider, environment: NodeJS.ProcessEnv = process.env) {
  const atomic = atomicRelease(provider, environment)
  // A present but invalid promotion is an error, not permission to resurrect an
  // older release from legacy fields. Removing the key explicitly restores pins.
  if (atomic) return atomic.readiness
  const input = releaseInput(provider, environment)
  const fields = {
    templateUrl: `DEN_MANAGED_DEPLOYMENT_${provider.toUpperCase()}_TEMPLATE_URL`,
    bundleUrl: `DEN_MANAGED_DEPLOYMENT_${provider.toUpperCase()}_BUNDLE_URL`,
    bundleSha256: `DEN_MANAGED_DEPLOYMENT_${provider.toUpperCase()}_BUNDLE_SHA256`,
    version: `DEN_MANAGED_DEPLOYMENT_${provider.toUpperCase()}_VERSION`,
    apiOrigin: "DEN_API_PUBLIC_URL",
  }
  const parsed = schemaFor(provider).safeParse(input)
  const missingFields = Object.entries(fields).filter(([key]) => {
    const value = Reflect.get(input, key)
    return typeof value !== "string" || !value.trim()
  }).map(([, name]) => name)
  const invalidFields = parsed.success ? [] : [...new Set(parsed.error.issues.flatMap((issue) => {
    const name = Reflect.get(fields, String(issue.path[0]))
    return typeof name === "string" && !missingFields.includes(name) ? [name] : []
  }))]
  return {
    provider,
    available: parsed.success,
    version: parsed.success ? parsed.data.version : null,
    reason: parsed.success ? "ready" : missingFields.length ? "not_configured" : "invalid_configuration",
    missingFields: [...missingFields, ...invalidFields],
  }
}

function release(provider: Provider, environment: NodeJS.ProcessEnv): ManagedDeploymentRelease | null {
  const atomic = atomicRelease(provider, environment)
  if (atomic) return atomic.release
  const parsed = schemaFor(provider).safeParse(releaseInput(provider, environment))
  return parsed.success ? parsed.data : null
}
export function awsRelease(environment: NodeJS.ProcessEnv = process.env): ManagedDeploymentRelease | null { return release("aws", environment) }
export function gcpRelease(environment: NodeJS.ProcessEnv = process.env): ManagedDeploymentRelease | null { return release("gcp", environment) }
