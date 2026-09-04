import { z } from "zod"

/** A portable starting point, never a backup of a person's working coworker. */
export const COWORKER_TEMPLATE_SCHEMA = "openwork.coworker.v1"
export const coworkerTemplateSchema = z.object({
  kind: z.literal("coworker"),
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(1024),
  role: z.string().trim().min(1).max(160),
  mission: z.string().trim().min(1).max(4000),
  instructions: z.string().trim().max(16000).default(""),
  avatarColor: z.enum(["blue", "violet", "mint", "orange", "rose", "slate"]).default("blue"),
  avatarGlasses: z.enum(["round", "square", "none"]).default("round"),
  provisioning: z.enum(["automatic", "optional"]).default("optional"),
}).strict()

export type CoworkerTemplate = z.infer<typeof coworkerTemplateSchema>

export const assignedCoworkerTemplateSchema = z.object({
  id: z.string().min(1),
  versionId: z.string().min(1),
  template: coworkerTemplateSchema,
  /** Explicit people, team, or marketplace access, not an admin's catalog visibility. */
  assigned: z.boolean(),
})
export const coworkerTemplateListSchema = z.object({
  /** Explicit organization opt-in; older servers fail closed. */
  enabled: z.boolean().default(false),
  items: z.array(assignedCoworkerTemplateSchema),
  nextCursor: z.string().nullable(),
})
export type AssignedCoworkerTemplate = z.infer<typeof assignedCoworkerTemplateSchema>
