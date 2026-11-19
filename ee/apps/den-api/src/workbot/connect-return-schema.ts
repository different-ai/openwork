import { z } from "zod"

/** Only a path is accepted from the browser; the deployment fixes the destination origin. */
export const workbotReturnPathSchema = z.string().max(2048).refine((path) => {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u0020]/.test(path)) return false
  try { return new URL(path, "https://workbot.invalid").origin === "https://workbot.invalid" } catch { return false }
})
export const workbotConnectRequestSchema = z.object({ returnPath: workbotReturnPathSchema, requestId: z.string().uuid() }).strict()
export const workbotOAuthReturnSchema = workbotConnectRequestSchema.extend({ origin: z.string().url() })
export type WorkbotOAuthReturn = z.infer<typeof workbotOAuthReturnSchema>
