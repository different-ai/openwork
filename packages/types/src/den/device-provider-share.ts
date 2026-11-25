import { z } from "zod"

/** How many provider ids one request may ask about. */
export const DEVICE_SHARE_MAX_PROVIDERS = 20

/**
 * - `shareable`: the organization's AI Gateway can serve this provider with one API key.
 * - `shared`: the organization already has an active AI Gateway provider for it.
 * - `unsupported`: not in the catalog, needs more than one key, or needs settings a person chooses.
 */
export const DEVICE_SHARE_PROVIDER_STATUSES = ["shareable", "shared", "unsupported"] as const
export type DeviceShareProviderStatus = (typeof DEVICE_SHARE_PROVIDER_STATUSES)[number]

/** Why the caller cannot share: they do not manage AI Gateway, or the deployment has no AI Gateway. */
export const DEVICE_SHARE_BLOCKERS = ["no_permission", "gateway_unavailable"] as const
export type DeviceShareBlocker = (typeof DEVICE_SHARE_BLOCKERS)[number]

export const deviceShareProviderSchema = z.object({
  providerId: z.string(),
  name: z.string(),
  status: z.enum(DEVICE_SHARE_PROVIDER_STATUSES),
  sharedAs: z.string().optional(),
})
export type DeviceShareProvider = z.infer<typeof deviceShareProviderSchema>

export const deviceShareOptionsSchema = z.object({
  canShare: z.boolean(),
  blocker: z.enum(DEVICE_SHARE_BLOCKERS).nullable(),
  managerName: z.string().nullable(),
  verificationRequired: z.boolean(),
  providers: z.array(deviceShareProviderSchema),
})
export type DeviceShareOptions = z.infer<typeof deviceShareOptionsSchema>

/** `?providerIds=anthropic,openai` as a de-duplicated list, capped at DEVICE_SHARE_MAX_PROVIDERS. */
export function parseDeviceShareProviderIds(value: string | null | undefined): string[] {
  const ids = (value ?? "").split(",").map((id) => id.trim()).filter((id) => id.length > 0 && id.length <= 255)
  return [...new Set(ids)].slice(0, DEVICE_SHARE_MAX_PROVIDERS)
}

/** The name the organization's provider gets: the catalog name, as an admin would type it in AI Gateway. */
export function deviceShareProviderName(catalogName: string | null | undefined, providerId: string): string {
  return (catalogName?.trim() || providerId).slice(0, 255)
}
