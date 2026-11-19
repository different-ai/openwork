type Timers = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

/**
 * Tells the computer broker which chats the person watches: on screen in a visible
 * OpenWork window. Their computer work follows along in view, beside OpenWork; other
 * chats work in the background. Each change waits `delayMs`, so quick thread switches
 * and a moment behind another window do not flip the mode.
 */
export function createComputerFollow(send: (sessionId: string, watching: boolean) => Promise<unknown>, delayMs = 1_000,
  timers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }) {
  const chats = new Map<string, { sent: boolean; timer?: unknown }>()
  return (sessionId: string, watching: boolean) => {
    const chat = chats.get(sessionId) ?? { sent: false }
    if (chat.timer !== undefined) timers.clear(chat.timer)
    chat.timer = undefined
    if (chat.sent === watching) {
      // Unwatched chats are the broker's default: nothing to remember.
      if (!watching) chats.delete(sessionId)
      return
    }
    chats.set(sessionId, chat)
    chat.timer = timers.set(() => {
      chat.timer = undefined
      chat.sent = watching
      if (!watching) chats.delete(sessionId)
      // An older desktop has no such command; its computer keeps working as before.
      void send(sessionId, watching).catch(() => {})
    }, delayMs)
  }
}
