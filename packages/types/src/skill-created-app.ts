import { z } from "zod"

const idSchema = z.string().trim().min(1).max(160)

export const skillCreatedAppSchemaVersion = "1" as const
export const skillCreatedPayloadSchema = z.object({
  schemaVersion: z.literal(skillCreatedAppSchemaVersion),
  /** Distinguishes a first save from a new immutable version of an existing skill. Absent means "created". */
  mode: z.enum(["created", "updated"]).optional(),
  name: z.string().trim().min(1).max(255),
  pluginId: idSchema,
  skillId: idSchema,
  description: z.string().trim().min(1).max(2_000),
  libraryUrl: z.string().url().nullable(),
})
export type SkillCreatedPayload = z.infer<typeof skillCreatedPayloadSchema>
