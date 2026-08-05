import { z } from "zod"

import {
  micxAffordanceDescriptorSchema,
  micxProviderRefSchema,
} from "./micx-affordance.js"

export const micxGuidanceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: micxProviderRefSchema,
  loading: z.enum(["eager", "catalog", "on-demand"]),
})
export type MicxGuidanceDescriptor = z.infer<typeof micxGuidanceDescriptorSchema>

export const micxFeatureContributionSchema = z.object({
  featureId: z.string().trim().min(1),
  provider: micxProviderRefSchema,
  affordances: z.array(micxAffordanceDescriptorSchema),
  guidance: z.array(micxGuidanceDescriptorSchema),
})
export type MicxFeatureContribution = z.infer<typeof micxFeatureContributionSchema>

export const micxProviderCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  contributions: z.array(micxFeatureContributionSchema),
})
export type MicxProviderCatalog = z.infer<typeof micxProviderCatalogSchema>

export const micxCapabilityResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    data: z.unknown(),
    additionalContext: z.array(z.string()).optional(),
  }),
  z.object({
    status: z.literal("guidance"),
    instructions: z.array(z.string()),
  }),
  z.object({
    status: z.literal("requires-user-action"),
    message: z.string(),
    action: z.string().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    retryable: z.boolean(),
  }),
])
export type MicxCapabilityResult = z.infer<typeof micxCapabilityResultSchema>
