import * as SecureStore from "expo-secure-store"

/**
 * Small settings kept on this phone: the Workbot a development build talks to, and which hello the person was
 * welcomed for. Not secret; the secure store is simply the one small key-value store the app already has.
 */
export const prefs = {
  get(key: string): string | null {
    try {
      return SecureStore.getItem(`workbot.pref.${key}`)
    } catch {
      return null
    }
  },
  set(key: string, value: string) {
    try {
      SecureStore.setItem(`workbot.pref.${key}`, value)
    } catch {
      // Not kept: the default applies next time.
    }
  },
}
