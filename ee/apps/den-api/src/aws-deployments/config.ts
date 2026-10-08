import { z } from "zod"

const releaseConfigurationSchema = z.object({
  templateUrl: z.string().url().refine((value) => new URL(value).protocol === "https:"),
  bundleUrl: z.string().url().refine((value) => new URL(value).protocol === "https:"),
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  apiOrigin: z.string().url().refine((value) => {
    const url = new URL(value)
    return url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash
  }),
})

// Operator configuration, never accepted from an organization or a runner.
// These are artifact locations, not feature switches.
export function awsDeploymentReleaseConfiguration() {
  const configuration = releaseConfigurationSchema.safeParse({
    templateUrl: process.env.DEN_AWS_DEPLOYMENT_TEMPLATE_URL,
    bundleUrl: process.env.DEN_AWS_DEPLOYMENT_BUNDLE_URL,
    bundleSha256: process.env.DEN_AWS_DEPLOYMENT_BUNDLE_SHA256,
    version: process.env.DEN_AWS_DEPLOYMENT_VERSION,
    apiOrigin: process.env.DEN_API_PUBLIC_URL,
  })
  return configuration.success ? configuration.data : null
}
