import { checkBotId } from "botid/server"
import { env } from "./env.js"

export type BotProtectionResult =
  | { ok: true }
  | { ok: false; status: 403; message: string }

export async function verifyBotProtection(): Promise<BotProtectionResult> {
  // Temporarily default BotID enforcement off until Den Web can initialize
  // BotID client protection on the browser-facing /api/den proxy routes.
  // Without that client-side setup, checkBotId() throws a Vercel
  // misconfiguration error and breaks login with a 500.
  if (env.devMode || !env.botIdProtectionEnabled) {
    return { ok: true }
  }

  try {
    const result = await checkBotId()
    if (result.isBot) {
      return { ok: false, status: 403, message: "Request verification failed." }
    }
  } catch {
    return { ok: false, status: 403, message: "Request verification failed." }
  }

  return { ok: true }
}
