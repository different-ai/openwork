import { z } from "zod"

/** Internal, service-authenticated facts. Never includes configuration values or tenant data. */
export const headlessServiceHealthSchema = z.strictObject({
  version: z.literal(1),
  service: z.literal("headless-runner"),
  modelConfigured: z.boolean(),
  resumeConfigured: z.boolean(),
  denOriginMatches: z.boolean().nullable(),
})
export type HeadlessServiceHealth = z.infer<typeof headlessServiceHealthSchema>

export const workbotServiceHealthSchema = z.strictObject({
  version: z.literal(1),
  service: z.literal("workbot"),
  runnerConfigured: z.boolean(),
  denOriginMatches: z.boolean().nullable(),
})
export type WorkbotServiceHealth = z.infer<typeof workbotServiceHealthSchema>
