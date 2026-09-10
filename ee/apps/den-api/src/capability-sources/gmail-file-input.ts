import { z } from "zod"

export const gmailFileInputPreflight = {
  ok: false,
  error: "file_input_requires_host",
  created: false,
  message: "Workspace attachments require a supporting OpenWork host. No draft was created. Do not retry without attachments.",
} as const

export const gmailFileInputPreflightSchema = z.object({
  ok: z.literal(gmailFileInputPreflight.ok),
  error: z.literal(gmailFileInputPreflight.error),
  created: z.literal(gmailFileInputPreflight.created),
  message: z.literal(gmailFileInputPreflight.message),
}).strict()
