import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { z } from "zod"
import {
  chatsSchema,
  connectionsSchema,
  errorCode,
  errorMessage,
  filesSchema,
  inChat,
  MAX_MESSAGE_CHARS,
  meSchema,
  previewSchema,
  threadSchema,
  type WorkbotPreview,
} from "./contract"
import { applyLiveEvent, parseLiveEvent, reconnectDelay, takeEvents, type LiveText } from "./live"

/**
 * Workbot's data, the same on every client: what is read, how often, and what each change refreshes. Each client
 * supplies the transport: signed-in requests to its Workbot server and a way to read the live stream.
 */
export type WorkbotTransport = {
  /** A JSON request to a Workbot API path, signed in as the person; resolves with the status and the parsed body. */
  request(path: string, init?: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; timeoutMs?: number }): Promise<{ status: number; ok: boolean; payload: unknown }>
  /** Opens the live stream at `path`: text as it arrives, until the stream ends. Throws when it can't be opened. */
  stream(path: string, signal: AbortSignal): Promise<AsyncIterable<string>>
  /** A kept file's bytes. */
  bytes(path: string): Promise<Uint8Array>
  /** The person's time zone, which their messages are dated in. */
  timeZone(): string
}

const TransportContext = createContext<WorkbotTransport | null>(null)

export function WorkbotTransportProvider({ transport, children }: { transport: WorkbotTransport; children: ReactNode }) {
  return createElement(TransportContext.Provider, { value: transport }, children)
}

export function useWorkbotTransport(): WorkbotTransport {
  const transport = useContext(TransportContext)
  if (!transport) throw new Error("Workbot needs a transport: render it inside <WorkbotTransportProvider>.")
  return transport
}

/**
 * The chat on screen: null for the person's main chat, or the id of one of their side chats. Everything read and
 * sent is for this chat.
 */
const ChatContext = createContext<string | null>(null)
export const WorkbotChatProvider = ChatContext.Provider
export function useWorkbotChat() {
  return useContext(ChatContext)
}

export const workbotMeKey = ["workbot", "me"] as const
export const workbotQueryKey = ["workbot", "thread"] as const
export const workbotChatsKey = ["workbot", "chats"] as const
export const workbotFilesKey = ["workbot", "files"] as const
export const workbotConnectionsKey = ["workbot", "connections"] as const

/** Who is signed in and what is on for them; null when nobody is (the client sends them to sign in). */
export function useWorkbotMe(enabled = true) {
  const transport = useWorkbotTransport()
  return useQuery({
    queryKey: workbotMeKey,
    enabled,
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      // No answer at all: this device is offline, or Workbot itself is down.
      const answer = await transport.request("/v1/workbot/me", { timeoutMs: 20_000 }).catch(() => null)
      if (!answer) throw new Error("Can't reach Workbot. Check your connection and try again.")
      const { status, ok, payload } = answer
      if (status === 401) return null
      if (!ok) throw new Error("Workbot couldn't reach OpenWork. Try again in a minute.")
      return meSchema.parse(payload)
    },
  })
}

/**
 * The conversation's newest `turns` turns. While the live stream is connected it is re-read only when the stream says
 * something changed; without it, it polls quickly while an answer is in progress.
 */
export function useWorkbotThread(input: { turns: number; awaiting: boolean; live: boolean }) {
  const transport = useWorkbotTransport()
  const chat = useWorkbotChat()
  return useQuery({
    queryKey: [...workbotQueryKey, chat ?? "main", input.turns],
    queryFn: async () => {
      const { ok, payload } = await transport.request(inChat(`/v1/workbot?turns=${input.turns}`, chat), { timeoutMs: 30_000 })
      if (!ok) throw new Error(errorMessage(payload, "Couldn't load the conversation."))
      return threadSchema.parse(payload)
    },
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const data = query.state.data
      const busy = input.awaiting || (data?.available === true && data.status === "busy")
      if (input.live) return busy ? 10_000 : 60_000
      return busy ? 1_500 : 20_000
    },
    refetchIntervalInBackground: false,
    retry: 2,
  })
}

/**
 * Keeps a live stream open while `enabled`: reply text as it is written, and a re-read of the conversation whenever
 * it changes. Re-reads are coalesced so a burst of changes costs one request. Reconnects with backoff; returns
 * whether it is connected.
 */
export function useWorkbotLive(enabled: boolean) {
  const transport = useWorkbotTransport()
  const queryClient = useQueryClient()
  const chat = useWorkbotChat()
  const [connected, setConnected] = useState(false)
  const [live, setLive] = useState<Record<string, LiveText>>({})
  const refetching = useRef<{ running: boolean; again: boolean }>({ running: false, again: false })

  useEffect(() => {
    if (!enabled) {
      setConnected(false)
      return
    }
    // Another chat: none of the text streaming in the last one belongs here.
    setLive({})
    const controller = new AbortController()
    let attempt = 0

    const refresh = async () => {
      const state = refetching.current
      if (state.running) {
        state.again = true
        return
      }
      state.running = true
      try {
        do {
          state.again = false
          await queryClient.refetchQueries({ queryKey: workbotQueryKey, type: "active" })
        } while (state.again && !controller.signal.aborted)
      } finally {
        state.running = false
      }
    }

    const handle = (data: string) => {
      const event = parseLiveEvent(data)
      if (!event) return
      if (event.type === "changed") {
        void refresh()
        return
      }
      setLive((current) => applyLiveEvent(current, event, Date.now()))
    }

    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          const chunks = await transport.stream(inChat("/v1/workbot/events", chat), controller.signal)
          setConnected(true)
          attempt = 0
          // Anything missed while disconnected is picked up by one re-read.
          void refresh()
          let buffer = ""
          for await (const chunk of chunks) {
            const taken = takeEvents(buffer + chunk)
            buffer = taken.rest
            for (const data of taken.events) handle(data)
          }
        } catch {
          // Reconnect below.
        }
        setConnected(false)
        if (controller.signal.aborted) break
        attempt += 1
        await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt)))
      }
    }
    void run()
    return () => controller.abort()
  }, [enabled, queryClient, chat, transport])

  return { connected, live }
}

export class WorkbotSendError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "WorkbotSendError"
  }
}

/** Why sending was refused, in the person's words. */
function sendRefused(status: number, payload: unknown) {
  if (status === 429) {
    return new WorkbotSendError(errorCode(payload) === "rate_limited" ? "You're sending messages quickly. Try again in a minute." : "Too many messages are waiting. Try again when this one is answered.", 429)
  }
  return new WorkbotSendError(errorMessage(payload, "That didn't send."), status)
}

export function useSendWorkbotMessage() {
  const transport = useWorkbotTransport()
  const queryClient = useQueryClient()
  const chat = useWorkbotChat()
  return useMutation({
    mutationFn: async (input: { id: string; text: string; attachments?: string[] }) => {
      if (input.text.length > MAX_MESSAGE_CHARS) throw new WorkbotSendError("That's too long for one message. Send it as a file instead.", 400)
      const { status, ok, payload } = await transport.request(inChat("/v1/workbot/messages", chat), {
        method: "POST",
        body: { ...input, timeZone: transport.timeZone() },
        timeoutMs: 30_000,
      })
      if (!ok) throw sendRefused(status, payload)
    },
    onSettled: async () => {
      // A side chat's first message starts it, so it joins the list.
      if (chat) void queryClient.invalidateQueries({ queryKey: workbotChatsKey })
      await queryClient.invalidateQueries({ queryKey: workbotQueryKey })
    },
  })
}

/** Answers a message whose answer failed again, in place: the conversation keeps one copy of the message. */
export function useRetryWorkbotMessage() {
  const transport = useWorkbotTransport()
  const queryClient = useQueryClient()
  const chat = useWorkbotChat()
  return useMutation({
    mutationFn: async (id: string) => {
      const { status, ok, payload } = await transport.request(inChat(`/v1/workbot/messages/${encodeURIComponent(id)}/retry`, chat), {
        method: "POST",
        body: { timeZone: transport.timeZone() },
        timeoutMs: 30_000,
      })
      if (!ok) throw sendRefused(status, payload)
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotQueryKey }),
  })
}

export function useStopWorkbot() {
  const transport = useWorkbotTransport()
  const queryClient = useQueryClient()
  const chat = useWorkbotChat()
  return useMutation({
    mutationFn: async () => {
      const { ok, payload } = await transport.request(inChat("/v1/workbot/stop", chat), { method: "POST", timeoutMs: 15_000 })
      if (!ok) throw new Error(errorMessage(payload, "Couldn't stop."))
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotQueryKey }),
  })
}

/**
 * The person's chats: when the main chat was last used, and their side chats, newest first. A side chat is named
 * shortly after its first answer, so the list is re-read while one has no name yet.
 */
export function useWorkbotChats(enabled: boolean) {
  const transport = useWorkbotTransport()
  return useQuery({
    queryKey: workbotChatsKey,
    enabled,
    queryFn: async () => {
      const { ok, payload } = await transport.request("/v1/workbot/chats", { timeoutMs: 15_000 })
      if (!ok) throw new Error(errorMessage(payload, "Couldn't load your chats."))
      return chatsSchema.parse(payload)
    },
    refetchInterval: (query) => (query.state.data?.side.some((chat) => !chat.title) ? 3_000 : false),
    retry: 1,
  })
}

/** Removes a side chat with everything in it. */
export function useRemoveWorkbotChat() {
  const transport = useWorkbotTransport()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (chatId: string) => {
      const { status, ok, payload } = await transport.request(`/v1/workbot/chats/${encodeURIComponent(chatId)}`, { method: "DELETE", timeoutMs: 15_000 })
      if (status === 409) throw new Error("It's still answering in this chat. Stop it first.")
      if (!ok) throw new Error(errorMessage(payload, "Couldn't remove it."))
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotChatsKey }),
  })
}

/**
 * The Gmail, Slack and Microsoft 365 connections the person's admins set up, for the welcome. While the person is
 * connecting one elsewhere it is re-read every two seconds, until it is ready.
 */
export function useWorkbotConnections(input: { enabled: boolean; waiting: boolean }) {
  const transport = useWorkbotTransport()
  return useQuery({
    queryKey: workbotConnectionsKey,
    enabled: input.enabled,
    queryFn: async () => {
      const { ok, payload } = await transport.request("/v1/workbot/connections", { timeoutMs: 15_000 })
      // Hosts without this route just have nothing to connect here.
      if (!ok) return []
      const parsed = connectionsSchema.safeParse(payload)
      return parsed.success ? parsed.data.connections : []
    },
    refetchInterval: input.waiting ? 2_000 : false,
    refetchOnWindowFocus: true,
    retry: 1,
  })
}

/** Leaving the welcome: Workbot starts the conversation with its own hello. */
export function useStartWorkbot() {
  const transport = useWorkbotTransport()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const { ok, payload } = await transport.request("/v1/workbot/hello", { method: "POST", body: { timeZone: transport.timeZone() }, timeoutMs: 30_000 })
      if (!ok) throw new Error(errorMessage(payload, "Couldn't start."))
      const parsed = z.object({ started: z.boolean() }).safeParse(payload)
      if (!parsed.success) throw new Error("Couldn't start.")
      return parsed.data
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotQueryKey }),
  })
}

/** What went wrong editing a message, in the person's words. */
function messageChangeError(status: number, payload: unknown, fallback: string) {
  if (status === 409 && errorCode(payload) === "busy") return "Workbot is still working on this. Stop it first."
  return errorMessage(payload, fallback)
}

/** Edits one of the person's messages; Workbot answers the edited message fresh, from that point on. */
export function useEditWorkbotMessage() {
  const transport = useWorkbotTransport()
  const queryClient = useQueryClient()
  const chat = useWorkbotChat()
  return useMutation({
    mutationFn: async (input: { id: string; newId: string; text: string; attachments?: string[] }) => {
      const { id, ...body } = input
      const { status, ok, payload } = await transport.request(inChat(`/v1/workbot/messages/${encodeURIComponent(id)}/edit`, chat), {
        method: "POST",
        body: { ...body, timeZone: transport.timeZone() },
        timeoutMs: 30_000,
      })
      if (!ok) throw new Error(messageChangeError(status, payload, "That didn't send."))
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotQueryKey }),
  })
}

/** Stops one background task from its card. */
export function useStopWorkbotTask() {
  const transport = useWorkbotTransport()
  const queryClient = useQueryClient()
  const chat = useWorkbotChat()
  return useMutation({
    mutationFn: async (taskId: string) => {
      const { ok, payload } = await transport.request(inChat(`/v1/workbot/tasks/${encodeURIComponent(taskId)}/stop`, chat), { method: "POST", timeoutMs: 15_000 })
      if (!ok) throw new Error(errorMessage(payload, "Couldn't stop it."))
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotQueryKey }),
  })
}

/** The chat's kept files. */
export function useWorkbotFiles(enabled: boolean) {
  const transport = useWorkbotTransport()
  const chat = useWorkbotChat()
  return useQuery({
    queryKey: [...workbotFilesKey, chat ?? "main"],
    enabled,
    queryFn: async () => {
      const { ok, payload } = await transport.request(inChat("/v1/workbot/files", chat), { timeoutMs: 30_000 })
      if (!ok) throw new Error(errorMessage(payload, "Couldn't load your files."))
      return filesSchema.parse(payload)
    },
  })
}

export function useDeleteWorkbotFile() {
  const transport = useWorkbotTransport()
  const queryClient = useQueryClient()
  const chat = useWorkbotChat()
  return useMutation({
    mutationFn: async (id: string) => {
      const { ok, payload } = await transport.request(inChat(`/v1/workbot/files/${id}`, chat), { method: "DELETE", timeoutMs: 15_000 })
      if (!ok) throw new Error(errorMessage(payload, "Couldn't delete that file."))
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotFilesKey }),
  })
}

/** A kept file's raw bytes, for previews that read the file (sheets, text, Markdown); `version` refetches a revision. */
export function useWorkbotFileBytes(id: string | null, version?: number) {
  const transport = useWorkbotTransport()
  const chat = useWorkbotChat()
  return useQuery({
    queryKey: ["workbot", "bytes", chat ?? "main", id, version ?? 0],
    enabled: Boolean(id),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    queryFn: async () => transport.bytes(inChat(`/v1/workbot/files/${id}`, chat)),
  })
}

/**
 * How a slide deck or document looks (page images Workbot's computer rendered), or null when it has none. A new
 * `version` keeps showing the previous pages until the revision's are ready.
 */
export function useWorkbotPreview(id: string | null, version?: number) {
  const transport = useWorkbotTransport()
  const chat = useWorkbotChat()
  return useQuery({
    queryKey: ["workbot", "preview", chat ?? "main", id, version ?? 0],
    enabled: Boolean(id),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<WorkbotPreview | null> => {
      const { status, ok, payload } = await transport.request(inChat(`/v1/workbot/files/${id}/preview`, chat), { timeoutMs: 30_000 })
      if (status === 404) return null
      if (!ok) throw new Error("The preview couldn't load.")
      const parsed = previewSchema.safeParse(payload)
      return parsed.success ? parsed.data : null
    },
  })
}
