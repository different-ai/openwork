import { z } from "zod"

const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:")
const releaseSchema = z.object({
  templateUrl: httpsUrl,
  bundleUrl: httpsUrl,
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  apiOrigin: z.string().url().refine((value) => {
    const url = new URL(value)
    return url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash
  }).transform((value) => new URL(value).origin),
})
export type ManagedDeploymentRelease = z.infer<typeof releaseSchema>

/**
 * The installer release an operator published for AWS. These locate reviewed
 * artifacts; they are not feature switches (the feature registry gates use).
 * Missing or invalid values make AWS launches unavailable.
 */
export function awsRelease(): ManagedDeploymentRelease | null {
  const parsed = releaseSchema.safeParse({
    templateUrl: process.env.DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL,
    bundleUrl: process.env.DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL,
    bundleSha256: process.env.DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256,
    version: process.env.DEN_MANAGED_DEPLOYMENT_AWS_VERSION,
    apiOrigin: process.env.DEN_API_PUBLIC_URL,
  })
  return parsed.success ? parsed.data : null
}
