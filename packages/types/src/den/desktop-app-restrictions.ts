import { z } from "zod"

export const desktopAppRestrictionsSchema = z.object({
  disallowNonCloudModels: z.boolean().optional(),
  blockZenModel: z.boolean().optional(),
  blockMultipleWorkspaces: z.boolean().optional(),
}).meta({ ref: "DenDesktopAppRestrictions" })

export type DesktopAppRestrictions = z.infer<typeof desktopAppRestrictionsSchema>

export function normalizeDesktopAppRestrictions(value: unknown): DesktopAppRestrictions {
  const parsed = desktopAppRestrictionsSchema.safeParse(value)
  if (parsed.success) {
    return {
      ...(parsed.data.disallowNonCloudModels === true ? { disallowNonCloudModels: true } : {}),
      ...(parsed.data.blockZenModel === true ? { blockZenModel: true } : {}),
      ...(parsed.data.blockMultipleWorkspaces === true ? { blockMultipleWorkspaces: true } : {}),
    }
  }

  const legacy = value as {
    models?: {
      removeZen?: unknown
    }
  } | null

  return {
    ...(legacy?.models?.removeZen === true ? { blockZenModel: true } : {}),
  }
}
