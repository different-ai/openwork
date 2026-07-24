import { z } from "zod"

import {
  openworkAffordanceDescriptorSchema,
  openworkProviderRefSchema,
} from "./openwork-affordance.js"

export const openworkGuidanceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: openworkProviderRefSchema,
  loading: z.enum(["eager", "catalog", "on-demand"]),
})
export type OpenworkGuidanceDescriptor = z.infer<typeof openworkGuidanceDescriptorSchema>

export const openworkFeatureContributionSchema = z.object({
  featureId: z.string().trim().min(1),
  provider: openworkProviderRefSchema,
  affordances: z.array(openworkAffordanceDescriptorSchema),
  guidance: z.array(openworkGuidanceDescriptorSchema),
})
export type OpenworkFeatureContribution = z.infer<typeof openworkFeatureContributionSchema>

export const openworkProviderCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  contributions: z.array(openworkFeatureContributionSchema),
})
export type OpenworkProviderCatalog = z.infer<typeof openworkProviderCatalogSchema>

export const openworkCapabilityResultSchema = z.discriminatedUnion("status", [
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
export type OpenworkCapabilityResult = z.infer<typeof openworkCapabilityResultSchema>
