import { z } from "zod"

export const PERSONAL_SKILLS_FORMAT = "openwork.personal-skills"
export const PERSONAL_SKILLS_VERSION = 1
export const PERSONAL_SKILLS_MAX_COUNT = 100
export const PERSONAL_SKILLS_MAX_BYTES = 8 * 1024 * 1024
export const PERSONAL_SKILL_SOURCE_MAX_BYTES = 1024 * 1024

/** A portable SKILL.md only; never accept IDs, payloads, files, grants or other workspace config. */
export const personalSkillsBundleSchema = z.strictObject({
  format: z.literal(PERSONAL_SKILLS_FORMAT),
  version: z.literal(PERSONAL_SKILLS_VERSION),
  skills: z.array(z.strictObject({
    source: z.string().min(1).max(PERSONAL_SKILL_SOURCE_MAX_BYTES),
  })).max(PERSONAL_SKILLS_MAX_COUNT),
})
export type PersonalSkillsBundle = z.infer<typeof personalSkillsBundleSchema>

export const personalSkillsImportResponseSchema = z.strictObject({
  created: z.number().int().min(0).max(PERSONAL_SKILLS_MAX_COUNT),
})
export type PersonalSkillsImportResponse = z.infer<typeof personalSkillsImportResponseSchema>
