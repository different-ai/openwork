import { z } from "zod"
import { computerFolderSchema, computerSourceRefSchema } from "@openwork/types/den/computers"

const sharingSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("computer"), id: z.string() }),
  z.strictObject({ kind: z.literal("workbot") }),
])

export const computerSharingSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  folders: z.array(z.strictObject({ path: computerFolderSchema, access: z.enum(["read", "edit"]) })).max(32).refine(
    (folders) => new Set(folders.map(({ path }) => path)).size === folders.length,
    "List each shared folder only once.",
  ),
  sources: z.array(sharingSourceSchema).max(16).refine(
    (sources) => new Set(sources.map((source) => source.kind === "workbot" ? "workbot" : `computer:${source.id}`)).size === sources.length,
    "List each source only once.",
  ),
}).meta({ ref: "ComputerSharingSettings" })
export type ComputerSharingSettings = z.infer<typeof computerSharingSettingsSchema>

export const DEFAULT_COMPUTER_SHARING_SETTINGS: ComputerSharingSettings = { enabled: false, folders: [], sources: [] }

export const computerSharingStateSchema = z.object({
  settings: computerSharingSettingsSchema,
  availability: z.discriminatedUnion("state", [
    z.object({ state: z.literal("available") }),
    z.object({
      state: z.literal("unavailable"),
      reason: z.enum(["unsupported_platform", "virtualization_unavailable", "organization_policy", "signed_out", "feature_off"]),
      message: z.string(),
    }),
  ]),
  organizationAllows: z.boolean().nullable(),
  revokedSources: z.array(z.object({ source: computerSourceRefSchema, revokedAt: z.string() })),
  sync: z.enum(["synced", "pending", "failed"]),
}).meta({ ref: "ComputerSharingState" })
export type ComputerSharingState = z.infer<typeof computerSharingStateSchema>
