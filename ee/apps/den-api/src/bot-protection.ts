import { checkBotId } from "botid/server"
import { env } from "./env.js"

export type BotProtectionResult =
  | { ok: true }
  | { ok: false; status: 403; message: string }

export async function verifyBotProtection(): Promise<BotProtectionResult> {
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
