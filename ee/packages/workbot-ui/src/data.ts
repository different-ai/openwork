"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { errorMessage as getErrorMessage, hostFetch, workbotHost } from "./host";

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
  app: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  updates: z.array(z.string()).default([]),
});
export type WorkbotStep = z.infer<typeof stepSchema>;
const partSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
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
});
export type WorkbotTask = z.infer<typeof taskSchema>;
const turnSchema = z.object({
  id: z.string(),
  text: z.string(),
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

const threadSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false), reason: z.enum(["workbot_not_enabled", "workbot_runner_unavailable"]) }),
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

/**
 * The conversation's newest `turns` turns. While the live stream is connected it is re-read only when
 * the stream says something changed; without it, it polls quickly while an answer is in progress.
 */
export function useWorkbotThread(input: { turns: number; awaiting: boolean; live: boolean }) {
  const chat = useWorkbotChat();
  return useQuery({
    queryKey: [...workbotQueryKey, chat ?? "main", input.turns],
    queryFn: async () => {
      const { response, payload } = await requestJson(inChat(`/v1/workbot?turns=${input.turns}`, chat), { method: "GET" }, 30_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Couldn't load the conversation."));
      return threadSchema.parse(payload);
    },
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const data = query.state.data;
      const busy = input.awaiting || (data?.available === true && data.status === "busy");
      if (input.live) return busy ? 10_000 : 60_000;
      return busy ? 1_500 : 20_000;
    },
    refetchIntervalInBackground: false,
    retry: 2,
  });
}

/** Reply text streamed for one turn's model call `step`, before that call is stored. */
/** A model call in progress: its text so far, and whether it has started a step (its computer, or anything else). */
export type LiveText = { step: number; text: string; working?: { on: "computer" | "other"; since: number } };

const liveEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("changed"), messageId: z.string(), status: z.string().optional() }),
  z.object({ type: z.literal("text"), messageId: z.string(), step: z.number(), delta: z.string(), reset: z.boolean().optional() }),
  z.object({ type: z.literal("working"), messageId: z.string(), step: z.number(), on: z.enum(["computer", "other"]) }),
]);

async function openStream(signal: AbortSignal, chat: string | null) {
  return hostFetch(inChat("/v1/workbot/events", chat), { headers: { Accept: "text/event-stream" }, signal, cache: "no-store" });
}

/**
 * Keeps a live stream open while the page is: reply text as it is written, and a re-read of the
 * conversation whenever it changes. Re-reads are coalesced so a burst of changes costs one request.
 * Reconnects with backoff; returns whether it is currently connected.
 */
export function useWorkbotLive(enabled: boolean) {
  const queryClient = useQueryClient();
  const chat = useWorkbotChat();
  const [connected, setConnected] = useState(false);
  const [live, setLive] = useState<Record<string, LiveText>>({});
  const refetching = useRef<{ running: boolean; again: boolean }>({ running: false, again: false });

  useEffect(() => {
    if (!enabled) return;
    // Another chat: none of the text streaming in the last one belongs here.
    setLive({});
    const controller = new AbortController();
    let attempt = 0;

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
        if (value.type === "working") {
          return { ...current, [value.messageId]: { step: value.step, text: sameStep ? previous.text : "", working: { on: value.on, since: Date.now() } } };
        }
        const text = value.reset || !sameStep ? value.delta : previous.text + value.delta;
        return { ...current, [value.messageId]: { step: value.step, text, ...(sameStep && previous.working && !value.reset ? { working: previous.working } : {}) } };
      });
    };

    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await openStream(controller.signal, chat);
          if (!response.ok || !response.body) throw new Error(`events_${response.status}`);
          setConnected(true);
          attempt = 0;
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
              if (/^event:\s*ready/m.test(block)) continue;
              const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
              if (data) handle(data);
            }
          }
        } catch {
          // Reconnect below.
        }
        setConnected(false);
        if (controller.signal.aborted) break;
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, attempt === 1 ? 250 : 1_000 * 2 ** Math.min(attempt - 2, 3))));
      }
    };
    void run();
    return () => controller.abort();
  }, [enabled, queryClient, chat]);

  return { connected, live };
}

export class WorkbotSendError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WorkbotSendError";
  }
}

/** The most one message can carry (the runner's limit); longer text goes as a file. */
export const MAX_MESSAGE_CHARS = 100_000;

/** Why sending was refused, in the person's words. */
function sendRefused(status: number, payload: unknown) {
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
    mutationFn: async (input: { id: string; text: string; attachments?: string[] }) => {
      if (input.text.length > MAX_MESSAGE_CHARS) throw new WorkbotSendError("That's too long for one message. Send it as a file instead.", 400);
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
    app: z.enum(["gmail", "slack", "microsoft"]),
    ready: z.boolean(),
    connectUrl: z.string().nullable(),
  })),
});
export type WorkbotConnection = z.infer<typeof connectionsSchema>["connections"][number];

/**
 * The Gmail, Slack and Microsoft 365 connections the person's admins set up, for the welcome screen. While the
 * person is connecting one in another tab it is re-read every two seconds, until it is ready.
 */
export function useWorkbotConnections(input: { enabled: boolean; waiting: boolean }) {
  return useQuery({
    queryKey: ["workbot", "connections"],
    enabled: input.enabled,
    queryFn: async () => {
      const { response, payload } = await requestJson("/v1/workbot/connections", { method: "GET" }, 15_000);
      // Hosts without this route just have nothing to connect here.
      if (!response.ok) return [];
      const parsed = connectionsSchema.safeParse(payload);
      return parsed.success ? parsed.data.connections : [];
    },
    refetchInterval: input.waiting ? 2_000 : false,
    refetchOnWindowFocus: true,
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
      if (!response.ok) throw new Error(getErrorMessage(payload, "Couldn't start."));
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

/** Edits one of the person's messages; Workbot answers the edited message fresh, from that point on. */
export function useEditWorkbotMessage() {
  const queryClient = useQueryClient();
  const chat = useWorkbotChat();
  return useMutation({
    mutationFn: async (input: { id: string; newId: string; text: string; attachments?: string[] }) => {
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
