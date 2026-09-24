import { z } from "zod"

/**
 * "Default for new chats": the model an organization's admin picked for
 * everyone. The desktop starts a person there unless they picked their own.
 */

/** What an admin saves: a Gateway provider and one of its catalog models. */
export const organizationDefaultModelInputSchema = z.object({
  providerId: z.string().trim().min(1).max(64),
  modelId: z.string().trim().min(1).max(255),
}).strict()
export type OrganizationDefaultModelInput = z.infer<typeof organizationDefaultModelInputSchema>

/** The default resolved for the caller: the routed model id they can select, and whether it needs their own sign-in first. */
export const memberDefaultModelSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  name: z.string(),
  needsSignIn: z.boolean(),
})
export type MemberDefaultModel = z.infer<typeof memberDefaultModelSchema>

export const organizationDefaultModelResponseSchema = z.object({
  /** What the admin saved, or null when the organization has no default. */
  configured: organizationDefaultModelInputSchema.extend({ name: z.string().nullable() }).nullable(),
  /** The same default resolved for the caller; null when they have no access to it. */
  defaultModel: memberDefaultModelSchema.nullable(),
})
export type OrganizationDefaultModelResponse = z.infer<typeof organizationDefaultModelResponseSchema>
