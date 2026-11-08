"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { workbotDocumentNavigationSchema, workbotViewContextSchema, WORKBOT_MAX_MESSAGE_CHARS, type WorkbotViewContext } from "@openwork/types/workbot-context";
import { errorMessage as getErrorMessage, hostFetch, workbotHost } from "./host";
import { liveRetryDelay, liveStreamOff, retryAfterMs } from "./live-retry";
import { workbotAccessFailureSchema, type WorkbotAccessReason } from "@openwork/types/den/workbot-settings";
import { loadThreadSnapshot, saveThreadSnapshot } from "./thread-cache";
import { workbotLiveReadiness } from "./live-readiness";
import { nextWorking } from "./computer-work";

const requestJson = (path: string, init?: RequestInit, timeoutMs?: number) => workbotHost().requestJson(path, init, timeoutMs);

/**
 * The chat the page shows: null for the person's main chat, or the id of one of their side chats. Everything the
 * page reads and sends is for this chat.
 */
const WorkbotChatContext = createContext<string | null>(null);
export const WorkbotChatProvider = WorkbotChatContext.Provider;
export function useWorkbotChat() {
  return useContext(WorkbotChatContext);
}

/** A Workbot path for a chat: a side chat adds `chat=<id>` to it. */
export function inChat(path: string, chat: string | null) {
  if (!chat) return path;
  return `${path}${path.includes("?") ? "&" : "?"}chat=${encodeURIComponent(chat)}`;
}

/** A new side chat's id: the page makes it, and the chat starts with its first message. */
export function newChatId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const stepSchema = z.object({
  label: z.string(),
  icon: z.enum(["app", "computer"]),
  status: z.enum(["running", "done"]),
  reason: z.string().optional(),
  app: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  updates: z.array(z.string()).default([]),
  /** Work in the computer's browser; absent for its other apps (and from older servers). */
  surface: z.literal("browser").optional(),
  /** Commands on the computer with no screen to watch (running Blender from the command line); absent for screen work. */
  background: z.literal(true).optional(),
  /** Whether Workbot put this screen work in front of the person: the last value it gave; absent when it gave none. */
  shown: z.boolean().optional(),
  /** Web pages it opened in the browser, each with a stable id for its link (/browser/<id>). */
  pages: z.array(z.object({ id: z.string(), url: z.string(), title: z.string() })).optional(),
  /** Work in a connected app: which of its tools ran, in plain words ("Web search"). Older servers omit it. */
  detail: z.string().optional(),
  /** The connected app's website ("exa.ai"), for its logo when its name alone finds none. */
  site: z.string().optional(),
  /** Work on another of the person's computers (a remote task). */
  remote: z.literal(true).optional(),
  /** Work in OpenWork itself (remote tasks, workflows, skills, Automations, Apps): one OpenWork logo. Older servers omit it. */
  openwork: z.literal(true).optional(),
});
export type WorkbotStep = z.infer<typeof stepSchema>;
export type WorkbotPage = NonNullable<WorkbotStep["pages"]>[number];
const partSchema = z.discriminatedUnion("kind", [
  /** `step`: the model call the words came from, so the page keeps one bubble per call. Older servers omit it. */
  z.object({ kind: z.literal("text"), text: z.string(), step: z.number().optional() }),
  z.object({ kind: z.literal("steps"), steps: z.array(stepSchema) }),
]);
export type WorkbotPart = z.infer<typeof partSchema>;
const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["queued", "working", "paused", "done", "failed", "stopped"]),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  update: z.string().nullable().default(null),
  updates: z.array(z.string()).default([]),
  /** Its steps so far in plain words, newest last (the last 12); older servers send none. */
  steps: z.array(z.object({ label: z.string(), done: z.boolean(), at: z.number().nullable() })).default([]),
  stepsDone: z.number().default(0),
  /** The latest thing it wrote, on one line, while it works. */
  note: z.string().nullable().default(null),
});
export type WorkbotTask = z.infer<typeof taskSchema>;
const turnSchema = z.object({
  id: z.string(),
  text: z.string(),
  context: workbotViewContextSchema.optional(),
  navigation: z.array(z.object({ id: z.string(), fileId: workbotDocumentNavigationSchema.shape.fileId })).default([]),
  sentAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  status: z.enum(["queued", "working", "done", "failed", "stopped"]),
  attachments: z.array(z.object({ id: z.string(), name: z.string(), mediaType: z.string(), size: z.number(), updatedAt: z.number().optional() })),
  /** Files Workbot made or revised while answering, to open from the answer. `updatedAt` moves with each revision. */
  outputs: z.array(z.object({ id: z.string(), name: z.string(), mediaType: z.string(), size: z.number(), updatedAt: z.number().optional() })).default([]),
  /** The emoji Workbot reacted to the message with, shown on the person's bubble. */
  reaction: z.string().nullable().default(null),
  parts: z.array(partSchema),
  modelSteps: z.number(),
  error: z.string().nullable(),
  modelIssue: z.enum(["free_limit", "usage_limit", "payment_required"]).optional(),
  /** A failed message that can work if answered again: "Try again" answers it again in place. */
  retryable: z.boolean().default(true),
  /** Bigger jobs this message handed to background tasks: shown where they started until they report back. */
  tasks: z.array(taskSchema).default([]),
  /** Workbot's first hello: it spoke first, so there is no message from the person above it. */
  greeting: z.boolean().default(false),
  /** Things the person could ask next, offered as buttons under the hello. */
  suggestions: z.array(z.string()).default([]),
});
export type WorkbotTurn = z.infer<typeof turnSchema>;

export const threadSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false), reason: z.enum(["workbot_not_enabled", "workbot_runner_unavailable", "workbot_model_unavailable"]) }),
  z.object({
    available: z.literal(true),
    name: z.string(),
    organizationName: z.string(),
    status: z.enum(["idle", "busy"]),
    turns: z.array(turnSchema),
    hasEarlier: z.boolean(),
    filesEnabled: z.boolean(),
  }),
]);
export type WorkbotThread = z.infer<typeof threadSchema>;

export const workbotQueryKey = ["workbot", "thread"] as const;

/** The first read of a chat: small enough to answer quickly; the rest of a page is read behind it (screen.tsx). */
export const WORKBOT_FIRST_TURNS = 8;
const threadKey = (chat: string | null, turns: number) => [...workbotQueryKey, chat ?? "main", turns] as const;

async function fetchThread(chat: string | null, turns: number) {
  const { response, payload } = await requestJson(inChat(`/v1/workbot?turns=${turns}`, chat), { method: "GET" }, 30_000);
  if (!response.ok) throw new Error(getErrorMessage(payload, "Couldn't load the conversation."));
  const thread = threadSchema.parse(payload);
  if (workbotHost().instantOpen) saveThreadSnapshot(workbotHost().identity, chat, thread);
  return thread;
}

/** The page this device kept for the chat, when it still reads as a conversation. */
function keptThread(chat: string | null) {
  const parsed = threadSchema.safeParse(loadThreadSnapshot(workbotHost().identity, chat));
  return parsed.success && parsed.data.available ? parsed.data : undefined;
}

/**
 * Reads a chat's first page ahead of opening it (a side chat's row touched or hovered), so the click finds it read.
 * A read made in the last 10 seconds is reused.
 */
export function prefetchWorkbotThread(queryClient: QueryClient, chat: string | null) {
  void queryClient.prefetchQuery({ queryKey: threadKey(chat, WORKBOT_FIRST_TURNS), queryFn: () => fetchThread(chat, WORKBOT_FIRST_TURNS), staleTime: 10_000 });
}

/**
 * The conversation's newest `turns` turns. While the live stream is connected it is re-read only when
 * the stream says something changed; without it, it polls quickly while an answer is in progress.
 * With `instantOpen`, a chat opens on the newest page kept on this device from the last visit while it is read again.
 */
export function useWorkbotThread(input: { turns: number; awaiting: boolean; live: boolean }) {
  const chat = useWorkbotChat();
  return useQuery({
    queryKey: threadKey(chat, input.turns),
    queryFn: () => fetchThread(chat, input.turns),
    // The previous window while a larger one is read; on a first open, what this device kept (instantOpen).
    placeholderData: (previous) => previous ?? (workbotHost().instantOpen ? keptThread(chat) : undefined),
    refetchInterval: (query) => {
      const data = query.state.data;
      const busy = input.awaiting || (data?.available === true && data.status === "busy");
      // A background task working alone doesn't make the conversation busy, but its progress is worth following.
      const tasks = data?.available === true && data.turns.some((turn) => turn.tasks.some((task) => task.status === "queued" || task.status === "working" || task.status === "paused"));
      if (input.live) return busy ? 10_000 : tasks ? 15_000 : 60_000;
      return busy ? 1_500 : tasks ? 5_000 : 20_000;
    },
    refetchIntervalInBackground: false,
    retry: 2,
  });
}

/** Reply text streamed for one turn's model call `step`, before that call is stored. */
/** A model call in progress: its text so far, and whether it has started a step (its computer, or anything else). */
export type LiveText = {
  step: number;
  text: string;
  /**
   * `background`: commands on its computer, with no screen to watch. `surface`: which screen that work is on (its
   * browser or the rest of its computer), once the call has said; absent until then, and the page doesn't guess.
   * `update`: what that computer work is doing, in its own words, before the step is stored.
   */
  working?: { on: "computer" | "other"; since: number; background?: true; surface?: "browser" | "computer"; update?: string };
  /** What earlier model calls of this turn wrote, kept until the conversation's next read has it. */
  earlier?: Array<{ step: number; text: string }>;
};

const liveEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("changed"), messageId: z.string(), status: z.string().optional() }),
  z.object({ type: z.literal("text"), messageId: z.string(), step: z.number(), delta: z.string(), reset: z.boolean().optional() }),
  z.object({ type: z.literal("working"), messageId: z.string(), step: z.number(), on: z.enum(["computer", "other"]), background: z.literal(true).optional(), surface: z.enum(["browser", "computer"]).optional(), update: z.string().optional() }),
]);

async function openStream(signal: AbortSignal, chat: string | null) {
  return hostFetch(inChat("/v1/workbot/events", chat), { headers: { Accept: "text/event-stream" }, signal, cache: "no-store" });
}

/**
 * Keeps a live stream open while the page is: reply text as it is written, and a re-read of the
 * conversation whenever it changes. Re-reads are coalesced so a burst of changes costs one request.
 * Reconnects with backoff (see `liveRetryDelay`); a hidden page tries again once it is shown. Returns whether it is
 * currently connected.
 */
export function useWorkbotLive(enabled: boolean) {
  const queryClient = useQueryClient();
  const chat = useWorkbotChat();
  const [connected, setConnected] = useState(false);
  const [live, setLive] = useState<Record<string, LiveText>>({});
  const refetching = useRef<{ running: boolean; again: boolean }>({ running: false, again: false });
  // Workbot isn't on for the organization: no stream until the page is shown again or a re-read finds it on.
  const [off, setOff] = useState(false);

  useEffect(() => {
    if (!off) return;
    const resume = () => setOff(false);
    const shown = () => {
      if (document.visibilityState === "visible") resume();
    };
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      const [scope, kind] = event.query.queryKey;
      const data: unknown = event.query.state.data;
      if (scope === workbotQueryKey[0] && kind === workbotQueryKey[1] && typeof data === "object" && data !== null && "available" in data && data.available === true) resume();
    });
    document.addEventListener("visibilitychange", shown);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", shown);
    };
  }, [off, queryClient]);

  useEffect(() => {
    if (!enabled || off) return;
    // Another chat: none of the text streaming in the last one belongs here.
    setLive({});
    const controller = new AbortController();
    const readiness = workbotLiveReadiness.subscribe(chat);
    // Waits that end as soon as the page leaves.
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        controller.signal.addEventListener("abort", done);
      });
    const untilShown = () =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (document.visibilityState === "hidden" && !controller.signal.aborted) return;
          document.removeEventListener("visibilitychange", check);
          controller.signal.removeEventListener("abort", check);
          resolve();
        };
        document.addEventListener("visibilitychange", check);
        controller.signal.addEventListener("abort", check);
        check();
      });

    const refresh = async () => {
      const state = refetching.current;
      if (state.running) {
        state.again = true;
        return;
      }
      state.running = true;
      try {
        do {
          state.again = false;
          await queryClient.refetchQueries({ queryKey: workbotQueryKey, type: "active" });
        } while (state.again && !controller.signal.aborted);
      } finally {
        state.running = false;
      }
    };

    const handle = (data: string) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch {
        return;
      }
      const event = liveEventSchema.safeParse(raw);
      if (!event.success) return;
      const value = event.data;
      if (value.type === "changed") {
        void refresh();
        return;
      }
      setLive((current) => {
        const previous = current[value.messageId];
        if (previous && value.step < previous.step) return current;
        const sameStep = previous?.step === value.step;
        // A finished model call's words stay until the conversation's next read has them, so they never blink out.
        const earlier = !sameStep && previous?.text ? [...(previous.earlier ?? []), { step: previous.step, text: previous.text }].slice(-3) : (previous?.earlier ?? []);
        if (value.type === "working") {
          return { ...current, [value.messageId]: { step: value.step, text: sameStep ? previous.text : "", earlier, working: nextWorking(sameStep ? previous.working : undefined, value) } };
        }
        const text = value.reset || !sameStep ? value.delta : previous.text + value.delta;
        return { ...current, [value.messageId]: { step: value.step, text, earlier, ...(sameStep && previous.working && !value.reset ? { working: previous.working } : {}) } };
      });
    };

    const run = async () => {
      // Refused or failed tries in a row; a stream that opens starts the count again.
      let failures = 0;
      while (!controller.signal.aborted) {
        let opened = false;
        let retryAfter: number | null = null;
        try {
          const response = await openStream(controller.signal, chat);
          if (!response.ok || !response.body) {
            retryAfter = retryAfterMs(response.headers.get("Retry-After"));
            if (liveStreamOff(response.status, await response.json().catch(() => null))) {
              // Trying again won't help until Workbot is turned on; the conversation's own reads show that it's off.
              setOff(true);
              return;
            }
            throw new Error(`events_${response.status}`);
          }
          opened = true;
          failures = 0;
          setConnected(true);
          // Anything missed while disconnected is picked up by one re-read.
          void refresh();
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let boundary = buffer.indexOf("\n\n");
            while (boundary !== -1) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf("\n\n");
              if (/^event:\s*ready/m.test(block)) { if (!controller.signal.aborted) readiness.ready(); continue; }
              const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
              if (data) handle(data);
            }
          }
        } catch {
          // Reconnect below.
        }
        readiness.disconnect();
        setConnected(false);
        if (controller.signal.aborted) break;
        if (!opened) failures += 1;
        await sleep(liveRetryDelay(failures, retryAfter));
        // Nobody sees a hidden page's live text, and the conversation is re-read when the stream opens again.
        if (failures > 0) await untilShown();
      }
    };
    void run();
    return () => { readiness.disconnect(); controller.abort(); };
  }, [enabled, off, queryClient, chat]);

  return { connected, live };
}

export class WorkbotSendError extends Error {
  constructor(message: string, readonly status: number, readonly accessReason?: WorkbotAccessReason) {
    super(message);
    this.name = "WorkbotSendError";
  }
}

/** The most one message can carry (the runner's limit); longer text goes as a file. */
export const MAX_MESSAGE_CHARS = WORKBOT_MAX_MESSAGE_CHARS;

/** Why sending was refused, in the person's words. */
function sendRefused(status: number, payload: unknown) {
  const access = workbotAccessFailureSchema.safeParse(payload);
  if (access.success) return new WorkbotSendError("Workbot's model access needs attention.", status, access.data.reason);
  if (status === 429) {
    const limited = typeof payload === "object" && payload !== null && "error" in payload && payload.error === "rate_limited";
    return new WorkbotSendError(limited ? "You're sending messages quickly. Try again in a minute." : "Too many messages are waiting. Try again when this one is answered.", 429);
  }
  return new WorkbotSendError(getErrorMessage(payload, "That didn't send."), status);
}

export function useSendWorkbotMessage() {
  const queryClient = useQueryClient();
  const chat = useWorkbotChat();
  return useMutation({
    mutationFn: async (input: { id: string; text: string; attachments?: string[]; context?: WorkbotViewContext; teachingId?: string; teachingStepId?: number }) => {
      if (input.text.length > MAX_MESSAGE_CHARS) throw new WorkbotSendError("That's too long for one message. Send it as a file instead.", 400);
      // Avoid racing the first streamed words on mount, but never make an unavailable stream block sending.
      if (workbotHost().quickReply) await workbotLiveReadiness.wait(chat);
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { response, payload } = await requestJson(inChat("/v1/workbot/messages", chat), {
        method: "POST",
        body: JSON.stringify({ ...input, timeZone }),
      }, 30_000);
      if (!response.ok) throw sendRefused(response.status, payload);
    },
    onSettled: async () => {
      // A side chat's first message starts it, so it joins the list.
      if (chat) void queryClient.invalidateQueries({ queryKey: workbotChatsKey });
      await queryClient.invalidateQueries({ queryKey: workbotQueryKey });
    },
  });
}

/** Answers a message whose answer failed again, in place: the conversation keeps one copy of the message. */
export function useRetryWorkbotMessage() {
  const queryClient = useQueryClient();
  const chat = useWorkbotChat();
  return useMutation({
    mutationFn: async (id: string) => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { response, payload } = await requestJson(
        inChat(`/v1/workbot/messages/${encodeURIComponent(id)}/retry`, chat),
        { method: "POST", body: JSON.stringify({ timeZone }) },
        30_000,
      );
      if (!response.ok) throw sendRefused(response.status, payload);
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotQueryKey }),
  });
}

export function useStopWorkbot() {
  const queryClient = useQueryClient();
  const chat = useWorkbotChat();
  return useMutation({
    mutationFn: async () => {
      const { response, payload } = await requestJson(inChat("/v1/workbot/stop", chat), { method: "POST" }, 15_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Couldn't stop."));
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotQueryKey }),
  });
}

const chatsSchema = z.object({
  main: z.object({ updatedAt: z.number() }).nullable(),
  side: z.array(z.object({ id: z.string(), title: z.string(), updatedAt: z.number() })),
});
export type WorkbotChats = z.infer<typeof chatsSchema>;
export const workbotChatsKey = ["workbot", "chats"] as const;

/**
 * The person's chats: when the main chat was last used, and their side chats, newest first. A side chat is named
 * shortly after its first answer, so the list is re-read while one has no name yet.
 */
export function useWorkbotChats(enabled: boolean) {
  return useQuery({
    queryKey: workbotChatsKey,
    enabled,
    queryFn: async () => {
      const { response, payload } = await requestJson("/v1/workbot/chats", { method: "GET" }, 15_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Couldn't load your chats."));
      return chatsSchema.parse(payload);
    },
    refetchInterval: (query) => (query.state.data?.side.some((chat) => !chat.title) ? 3_000 : false),
    retry: 1,
  });
}

/** Removes a side chat with everything in it. */
export function useRemoveWorkbotChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (chatId: string) => {
      const { response, payload } = await requestJson(`/v1/workbot/chats/${encodeURIComponent(chatId)}`, { method: "DELETE" }, 15_000);
      if (response.status === 409) throw new Error("It's still answering in this chat. Stop it first.");
      if (!response.ok) throw new Error(getErrorMessage(payload, "Couldn't remove it."));
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotChatsKey }),
  });
}

const connectionsSchema = z.object({
  connections: z.array(z.object({
    id: z.string(),
    name: z.string(),
    app: z.enum(["gmail", "googleCalendar", "slack", "microsoft"]),
    ready: z.boolean(),
    connectUrl: z.string().nullable(),
    nativeProviderKey: z.string().nullable().optional(),
    connectMode: z.enum(["inline", "external", "admin"]).optional(),
  })),
  /** Every app the person can use, connected or not (`workbotProfileSheet`); older Dens leave it out. */
  apps: z.array(z.object({
    id: z.string(),
    name: z.string(),
    iconCandidates: z.array(z.string()).optional(),
    nativeProviderKey: z.string().nullable(),
    authType: z.enum(["oauth", "apikey", "none"]),
    status: z.enum(["connected", "needs_sign_in", "not_connected", "needs_attention"]),
    managedBy: z.enum(["you", "organization"]),
    action: z.enum(["connect", "ask_admin", "admin_settings"]).nullable(),
    connectMode: z.enum(["inline", "external", "admin"]),
    connectUrl: z.string().nullable(),
    ready: z.boolean(),
  })).optional(),
});
export type WorkbotConnection = z.infer<typeof connectionsSchema>["connections"][number];
export type WorkbotApp = NonNullable<z.infer<typeof connectionsSchema>["apps"]>[number];
type WorkbotConnectionsPayload = z.infer<typeof connectionsSchema>;

const APP_ORDER: Record<WorkbotApp["status"], number> = { connected: 0, needs_sign_in: 1, not_connected: 2, needs_attention: 3 };

/** From a Den without `apps`: the everyday connections it does list, in the same shape and order. */
export function appsFromConnections(connections: readonly WorkbotConnection[]): WorkbotApp[] {
  return connections.map((connection): WorkbotApp => {
    const admin = connection.connectMode === "admin" || (!connection.ready && !connection.connectUrl && connection.connectMode !== "inline");
    return {
      id: connection.id, name: connection.name, nativeProviderKey: connection.nativeProviderKey ?? null, authType: "oauth",
      status: connection.ready ? "connected" : admin ? "not_connected" : "needs_sign_in",
      managedBy: admin ? "organization" : "you",
      action: connection.ready ? null : admin ? "ask_admin" : "connect",
      connectMode: connection.connectMode ?? "external", connectUrl: connection.connectUrl, ready: connection.ready,
    };
  }).sort((a, b) => APP_ORDER[a.status] - APP_ORDER[b.status] || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

function connectionsQuery(input: { enabled: boolean; waiting: boolean }) {
  return {
    queryKey: ["workbot", "connections", workbotHost().identity?.organizationId, workbotHost().identity?.principalId],
    enabled: input.enabled,
    queryFn: async (): Promise<WorkbotConnectionsPayload> => {
      const { response, payload } = await requestJson("/v1/workbot/connections", { method: "GET" }, 15_000);
      // Hosts without this route just have nothing to connect here.
      if (!response.ok) throw new Error("Couldn't verify your connections. Try again.");
      return connectionsSchema.parse(payload);
    },
    refetchInterval: input.waiting ? 2_000 : false as const,
    refetchOnWindowFocus: true,
    retry: 1,
  };
}

/**
 * Every app the person can use from Workbot, connected or not, for the Apps list on its profile: Connected first,
 * then Needs sign-in, Not connected and Needs attention. The same request (and cache) as the everyday connections.
 */
export function useWorkbotApps(input: { enabled: boolean; waiting: boolean }) {
  return useQuery({ ...connectionsQuery(input), select: (payload: WorkbotConnectionsPayload) => payload.apps ?? appsFromConnections(payload.connections) });
}

/**
 * The Gmail, Slack and Microsoft 365 connections the person's admins set up, for the welcome screen. While the
 * person is connecting one in another tab it is re-read every two seconds, until it is ready.
 */
export function useWorkbotConnections(input: { enabled: boolean; waiting: boolean }) {
  return useQuery({ ...connectionsQuery(input), select: (payload: WorkbotConnectionsPayload) => payload.connections });
}

const memorySchema = z.object({ files: z.array(z.object({ name: z.string(), updatedAt: z.number(), content: z.string() })) });
export type WorkbotMemoryFile = z.infer<typeof memorySchema>["files"][number];

/** What Workbot remembers about the person, read-only, for its profile; read each time the Memory tab opens. */
export function useWorkbotMemory(enabled: boolean) {
  return useQuery({
    queryKey: ["workbot", "memory", workbotHost().identity?.organizationId, workbotHost().identity?.principalId],
    enabled,
    queryFn: async () => {
      const { response, payload } = await requestJson("/v1/workbot/memory", { method: "GET" }, 30_000);
      if (!response.ok) throw new Error("Couldn't read what I remember.");
      return memorySchema.parse(payload).files;
    },
    staleTime: 0,
    retry: 1,
  });
}

/** Leaving the welcome screen: Workbot starts the conversation with its own hello. */
export function useStartWorkbot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { response, payload } = await requestJson("/v1/workbot/hello", { method: "POST", body: JSON.stringify({ timeZone }) }, 30_000);
      if (!response.ok) throw sendRefused(response.status, payload);
      const parsed = z.object({ started: z.boolean() }).safeParse(payload);
      if (!parsed.success) throw new Error("Couldn't start.");
      return parsed.data;
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotQueryKey }),
  });
}

/** What went wrong deleting or editing a message, in the person's words. */
function messageChangeError(status: number, payload: unknown, fallback: string) {
  if (status === 409 && typeof payload === "object" && payload !== null && "error" in payload && payload.error === "busy") {
    return "Workbot is still working on this. Stop it first.";
  }
  return getErrorMessage(payload, fallback);
}

/** Deletes one of the person's messages and Workbot's answer to it. */
export function useDeleteWorkbotMessage() {
  const queryClient = useQueryClient();
  const chat = useWorkbotChat();
  return useMutation({
    mutationFn: async (id: string) => {
      const { response, payload } = await requestJson(inChat(`/v1/workbot/messages/${encodeURIComponent(id)}`, chat), { method: "DELETE" }, 15_000);
      if (!response.ok) throw new Error(messageChangeError(response.status, payload, "Couldn't delete it."));
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotQueryKey }),
  });
}

/** Sends a correction as a new message; earlier messages and replies remain in the conversation. */
export function useEditWorkbotMessage() {
  const queryClient = useQueryClient();
  const chat = useWorkbotChat();
  return useMutation({
    mutationFn: async (input: { id: string; newId: string; text: string; attachments?: string[]; context?: WorkbotViewContext }) => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { id, ...body } = input;
      const { response, payload } = await requestJson(
        inChat(`/v1/workbot/messages/${encodeURIComponent(id)}/edit`, chat),
        { method: "POST", body: JSON.stringify({ ...body, timeZone }) },
        30_000,
      );
      if (!response.ok) throw new Error(messageChangeError(response.status, payload, "That didn't send."));
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotQueryKey }),
  });
}

/** Stops one background task from its card. */
export function useStopWorkbotTask() {
  const queryClient = useQueryClient();
  const chat = useWorkbotChat();
  return useMutation({
    mutationFn: async (taskId: string) => {
      const { response, payload } = await requestJson(inChat(`/v1/workbot/tasks/${encodeURIComponent(taskId)}/stop`, chat), { method: "POST" }, 15_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Couldn't stop it."));
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotQueryKey }),
  });
}

const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number(),
  source: z.enum(["user", "agent"]),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
});
export type WorkbotFile = z.infer<typeof fileSchema>;
export type WorkbotAttachment = WorkbotTurn["attachments"][number];

export const workbotFilesKey = ["workbot", "files"] as const;

/** The chat's kept files. */
export function useWorkbotFiles(enabled: boolean) {
  const chat = useWorkbotChat();
  return useQuery({
    queryKey: [...workbotFilesKey, chat ?? "main"],
    enabled,
    queryFn: async () => {
      const { response, payload } = await requestJson(inChat("/v1/workbot/files", chat), { method: "GET" }, 30_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Couldn't load your files."));
      return z.object({ enabled: z.boolean(), files: z.array(fileSchema) }).parse(payload);
    },
  });
}

export function useDeleteWorkbotFile() {
  const queryClient = useQueryClient();
  const chat = useWorkbotChat();
  return useMutation({
    mutationFn: async (id: string) => {
      const { response, payload } = await requestJson(inChat(`/v1/workbot/files/${id}`, chat), { method: "DELETE" }, 15_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Couldn't delete that file."));
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotFilesKey }),
  });
}

/** Uploads one file to a chat with progress. Resolves with the kept file; rejects with a person-readable message. */
export async function uploadWorkbotFile(file: File, onProgress: (loaded: number) => void, signal: AbortSignal, chat: string | null): Promise<WorkbotFile> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const path = inChat(`/v1/workbot/files?${new URLSearchParams({ name: file.name || "file", timeZone }).toString()}`, chat);
  const target = await workbotHost().prepare(path);
  if (signal.aborted) throw new Error("Canceled.");
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", target.url);
    request.withCredentials = target.credentials === "include";
    target.headers.forEach((value, key) => request.setRequestHeader(key, value));
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onload = () => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(request.responseText);
      } catch {
        payload = null;
      }
      const parsed = fileSchema.safeParse(payload);
      if (request.status === 201 && parsed.success) resolve(parsed.data);
      else reject(new Error(request.status === 409 ? "Files aren't available right now." : "Couldn't upload."));
    };
    request.onerror = () => reject(new Error("Couldn't upload."));
    request.onabort = () => reject(new Error("Canceled."));
    signal.addEventListener("abort", () => request.abort(), { once: true });
    request.send(file);
  });
}

/** A kept file's bytes as an object URL (thumbnails and downloads), fetched with the page's credentials. */
export async function fetchWorkbotFileUrl(id: string, chat: string | null, inline = false) {
  const response = await hostFetch(inChat(`/v1/workbot/files/${id}${inline ? "?inline=1" : ""}`, chat));
  if (!response.ok) throw new Error("This file is no longer available.");
  return URL.createObjectURL(await response.blob());
}

/** A kept file's raw bytes, for previews that read the file (spreadsheets, text, slides); `version` refetches a revision. */
export function useWorkbotFileBytes(id: string | null, version?: number) {
  const chat = useWorkbotChat();
  return useQuery({
    queryKey: ["workbot", "bytes", chat ?? "main", id, version ?? 0],
    enabled: Boolean(id),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    queryFn: async () => {
      const response = await hostFetch(inChat(`/v1/workbot/files/${id}`, chat));
      if (!response.ok) throw new Error("This file is no longer available.");
      return new Uint8Array(await response.arrayBuffer());
    },
  });
}

/** An object URL for a kept file (PDF, video, audio). */
export function useWorkbotFileUrl(id: string | null, version?: number) {
  const chat = useWorkbotChat();
  return useQuery({
    queryKey: ["workbot", "url", chat ?? "main", id, version ?? 0],
    enabled: Boolean(id),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    queryFn: async () => fetchWorkbotFileUrl(id ?? "", chat),
  });
}

const previewSchema = z.object({ pages: z.number().int().min(1), width: z.number().int().min(1), height: z.number().int().min(1) });
export type WorkbotPreview = z.infer<typeof previewSchema>;

const previewFetch = (path: string) => hostFetch(path);

/**
 * How a slide deck or document looks (page images Workbot's computer rendered), or null when it has none. A new
 * `version` keeps showing the previous pages until the revision's are ready.
 */
export function useWorkbotPreview(id: string | null, version?: number) {
  const chat = useWorkbotChat();
  return useQuery({
    queryKey: ["workbot", "preview", chat ?? "main", id, version ?? 0],
    enabled: Boolean(id),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<WorkbotPreview | null> => {
      const response = await previewFetch(inChat(`/v1/workbot/files/${id}/preview`, chat));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("The preview couldn't load.");
      const parsed = previewSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    },
  });
}

/** One page of a preview as an object URL. */
export function useWorkbotPreviewPage(id: string, page: number, version?: number) {
  const chat = useWorkbotChat();
  return useQuery({
    queryKey: ["workbot", "preview-page", chat ?? "main", id, page, version ?? 0],
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const response = await previewFetch(inChat(`/v1/workbot/files/${id}/preview/${page}`, chat));
      if (!response.ok) throw new Error("This page couldn't load.");
      return URL.createObjectURL(await response.blob());
    },
  });
}

export function useWorkbotImageUrl(id: string | null, version?: number) {
  const chat = useWorkbotChat();
  const query = useQuery({
    queryKey: ["workbot", "image", chat ?? "main", id, version ?? 0],
    enabled: Boolean(id),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    queryFn: async () => fetchWorkbotFileUrl(id ?? "", chat, true),
  });
  return query.data ?? null;
}

export async function downloadWorkbotFile(file: { id: string; name: string }, chat: string | null) {
  const url = await fetchWorkbotFileUrl(file.id, chat);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
