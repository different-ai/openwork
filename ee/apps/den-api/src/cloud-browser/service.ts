import { createCloudBrowser, type BrowserKey, type CloudBrowser } from "@openwork-ee/cloud-browser"
import { createDaytonaBrowserHost } from "@openwork-ee/cloud-browser/daytona"
import { createLocalBrowserHost } from "@openwork-ee/cloud-browser/local"
import { createDaytonaProvider } from "@openwork-ee/cloud-runtime-daytona"
import { env } from "../env.js"
import { organizationHasCapability } from "../organization-capabilities.js"

/**
 * The deployment's cloud browser (see @openwork-ee/cloud-browser). Configured
 * by DEN_CLOUD_BROWSER_PROVIDER; unset means no organization can use it.
 * Organizations additionally need the default-off `cloudBrowser` capability.
 */
let configured: CloudBrowser | null | undefined

export function getCloudBrowser(): CloudBrowser | null {
  if (configured !== undefined) return configured
  const config = env.cloudBrowser
  if (!config) {
    configured = null
  } else if (config.provider === "daytona") {
    const snapshot = config.daytonaSnapshot
    const apiKey = env.daytona.apiKey
    configured = snapshot && apiKey
      ? createCloudBrowser(createDaytonaBrowserHost({
          provider: createDaytonaProvider({
            apiKey,
            apiUrl: env.daytona.apiUrl,
            target: env.daytona.target,
            snapshot,
            image: env.daytona.image,
            resources: { cpu: 1, memoryGb: 2, diskGb: 4 },
            pollIntervalMs: 500,
            helperCreateTimeoutMs: env.daytona.createTimeoutSeconds * 1_000,
          }),
          snapshot,
          namePrefix: config.daytonaNamePrefix,
        }))
      : null
  } else {
    // Development only: Chrome runs on the Den host itself.
    configured = createCloudBrowser(createLocalBrowserHost({
      chromePath: config.chromePath ?? undefined,
      profileRoot: config.profileDir ?? undefined,
    }))
  }
  return configured
}

export function cloudBrowserEnabledFor(organizationMetadata: Parameters<typeof organizationHasCapability>[0]): boolean {
  return organizationHasCapability(organizationMetadata, "cloudBrowser")
}

/** The person's own live view in Den Web, for hand-off links outside a chat. */
export function cloudBrowserPageUrl(site?: string | null): string {
  const url = new URL("/browser", env.betterAuthUrl)
  if (site) url.searchParams.set("site", site)
  return url.toString()
}

export function cloudBrowserKey(input: { organizationId: string; memberId: string }): BrowserKey {
  return { organizationId: input.organizationId, memberId: input.memberId }
}
