type Timers = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

export function createComputerFollow(send: (sessionId: string, watching: boolean) => Promise<unknown>, delayMs = 1_000,
  timers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }) {
  const chats = new Map<string, { sent: boolean; timer?: unknown }>()
  return (sessionId: string, watching: boolean) => {
    const chat = chats.get(sessionId) ?? { sent: false }
    if (chat.timer !== undefined) timers.clear(chat.timer)
    chat.timer = undefined
    if (chat.sent === watching) {
      if (!watching) chats.delete(sessionId)
      return
    }
    chats.set(sessionId, chat)
    chat.timer = timers.set(() => {
      chat.timer = undefined
      chat.sent = watching
      if (!watching) chats.delete(sessionId)
      void send(sessionId, watching).catch(() => {})
    }, delayMs)
  }
}
