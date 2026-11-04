import { create } from "zustand"

type Chats = Readonly<Record<string, true>>

function mark(chats: Chats, sessionId: string, value: boolean): Chats {
  if (Boolean(chats[sessionId]) === value) return chats
  const next = { ...chats }
  if (value) next[sessionId] = true
  else delete next[sessionId]
  return next
}

export const useComputerSessionHistoryStore = create<{
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  /** `parallelComputerUse`: a chat's card also covers what its subagents did. */
  parallel: boolean
  setParallel: (parallel: boolean) => void
  /** Chats whose computer is working now: their card offers the live view. */
  working: Chats
  /** Chats where the person opened the live view from the card. */
  watching: Chats
  setWorking: (sessionId: string, working: boolean) => void
  setWatching: (sessionId: string, watching: boolean) => void
}>((set) => ({
  enabled: false,
  setEnabled: enabled => set(state => state.enabled === enabled ? state : { enabled }),
  parallel: false,
  setParallel: parallel => set(state => state.parallel === parallel ? state : { parallel }),
  working: {},
  watching: {},
  setWorking: (sessionId, working) => set(state => {
    const next = mark(state.working, sessionId, working)
    return next === state.working ? state : { working: next }
  }),
  setWatching: (sessionId, watching) => set(state => {
    const next = mark(state.watching, sessionId, watching)
    return next === state.watching ? state : { watching: next }
  }),
}))
