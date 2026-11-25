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
  agents: Readonly<Record<string, string>>
  setAgent: (sessionId: string, agentSessionId: string | null) => void
  working: Chats
  watching: Chats
  setWorking: (sessionId: string, working: boolean) => void
  setWatching: (sessionId: string, watching: boolean) => void
}>((set) => ({
  agents: {},
  setAgent: (sessionId, agentSessionId) => set(state => {
    if ((state.agents[sessionId] ?? null) === agentSessionId) return state
    const agents = { ...state.agents }
    if (agentSessionId) agents[sessionId] = agentSessionId
    else delete agents[sessionId]
    return { agents }
  }),
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
