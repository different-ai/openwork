import * as SecureStore from "expo-secure-store"
import { z } from "zod"

/**
 * The person's Workbot session, in the Keychain (iOS) or the Keystore (Android), on this device only. Values are split
 * into parts because a sealed session can be larger than one secure-store value comfortably holds.
 */
const KEY = "workbot.session.v1"
const PART = 1_800
const options: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

export const storedSessionSchema = z.object({ value: z.string().min(1), expiresAt: z.number() })
export type StoredSession = z.infer<typeof storedSessionSchema>

let writes: Promise<unknown> = Promise.resolve()
/** Writes happen one after another, so a slow older write never lands after a newer one. */
function serial<T>(action: () => Promise<T>): Promise<T> {
  const result = writes.then(action, action)
  writes = result.catch(() => undefined)
  return result
}

async function clearParts() {
  const count = Number((await SecureStore.getItemAsync(`${KEY}.parts`, options)) ?? "0")
  for (let index = 0; index < count; index += 1) await SecureStore.deleteItemAsync(`${KEY}.${index}`, options)
  await SecureStore.deleteItemAsync(`${KEY}.parts`, options)
}

export const sessionStore = {
  async read(): Promise<StoredSession | null> {
    await writes
    const count = Number((await SecureStore.getItemAsync(`${KEY}.parts`, options)) ?? "0")
    if (!count) return null
    const parts: string[] = []
    for (let index = 0; index < count; index += 1) {
      const part = await SecureStore.getItemAsync(`${KEY}.${index}`, options)
      if (part === null) return null
      parts.push(part)
    }
    try {
      const parsed = storedSessionSchema.safeParse(JSON.parse(parts.join("")))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  },
  write: (session: StoredSession) =>
    serial(async () => {
      const text = JSON.stringify(session)
      await clearParts()
      const count = Math.ceil(text.length / PART)
      for (let index = 0; index < count; index += 1) await SecureStore.setItemAsync(`${KEY}.${index}`, text.slice(index * PART, (index + 1) * PART), options)
      await SecureStore.setItemAsync(`${KEY}.parts`, String(count), options)
    }),
  clear: () => serial(clearParts),
}
