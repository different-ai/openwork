import type { ToolPart } from "@opencode-ai/sdk/v2/client";

import { createClient } from "../../../../app/lib/opencode";
import { normalizeEvent, safeStringify } from "../../../../app/utils";

const MAX_AUDIT_ENTRIES = 500;
const SUMMARY_MAX_CHARS = 220;

type Listener = () => void;

type AuditEntrySource = "tool" | "pty" | "session-error";
type AuditEntryStatus = "pending" | "running" | "completed" | "error";

export type AuditEntry = {
  id: string;
  source: AuditEntrySource;
  sessionId: string;
  timestamp: number;
  title: string;
  status: AuditEntryStatus;
  inputSummary: string;
  outputSummary: string;
  toolName?: string;
  ptyId?: string;
  callId?: string;
};

export type SessionAuditSnapshot = {
  entries: AuditEntry[];
  connected: boolean;
  error: string | null;
};

export type SessionAuditStore = {
  subscribe: (listener: Listener) => () => void;
  getSnapshot: () => SessionAuditSnapshot;
  dispose: () => void;
};

type CreateSessionAuditStoreInput = {
  opencodeBaseUrl: string;
  openworkToken: string;
  sessionId: string;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function readString(record: UnknownRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readNumber(record: UnknownRecord, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summarizeValue(value: unknown, maxChars = SUMMARY_MAX_CHARS): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : safeStringify(value);
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}...`;
}

function mapToolStatus(status: string): AuditEntryStatus {
  if (status === "completed") return "completed";
  if (status === "error") return "error";
  if (status === "running") return "running";
  return "pending";
}

function getErrorMessage(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";
  const direct = readString(record, "message");
  if (direct) return direct;
  const data = asRecord(record.data);
  if (!data) return "";
  return readString(data, "message");
}

function trimEntries(entries: AuditEntry[]): AuditEntry[] {
  if (entries.length <= MAX_AUDIT_ENTRIES) return entries;
  return entries.slice(entries.length - MAX_AUDIT_ENTRIES);
}

export function createSessionAuditStore(input: CreateSessionAuditStoreInput): SessionAuditStore {
  const listeners = new Set<Listener>();
  const abortController = new AbortController();
  const toolEntryByPartId = new Map<string, string>();
  const ptyEntryById = new Map<string, string>();

  let nextId = 0;
  let disposed = false;
  let started = false;
  let snapshot: SessionAuditSnapshot = {
    entries: [],
    connected: false,
    error: null,
  };

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setSnapshotAndEmit = (updater: (current: SessionAuditSnapshot) => SessionAuditSnapshot) => {
    snapshot = updater(snapshot);
    emit();
  };

  const setSnapshotSilently = (updater: (current: SessionAuditSnapshot) => SessionAuditSnapshot) => {
    snapshot = updater(snapshot);
  };

  const addEntry = (entry: AuditEntry) => {
    setSnapshotAndEmit((current) => ({
      ...current,
      entries: trimEntries([...current.entries, entry]),
    }));
  };

  const updateEntry = (entryId: string, updater: (entry: AuditEntry) => AuditEntry) => {
    setSnapshotAndEmit((current) => {
      const index = current.entries.findIndex((item) => item.id === entryId);
      if (index === -1) return current;
      const entries = current.entries.slice();
      entries[index] = updater(entries[index]!);
      return { ...current, entries };
    });
  };

  const createEntryId = () => {
    nextId += 1;
    return `audit:${input.sessionId}:${Date.now()}:${nextId}`;
  };

  const handleToolPartUpdated = (properties: UnknownRecord) => {
    const part = properties.part;
    const partRecord = asRecord(part);
    if (!partRecord) return;
    if (readString(partRecord, "type") !== "tool") return;

    const partSessionId = readString(partRecord, "sessionID");
    const eventSessionId = readString(properties, "sessionID");
    const ownerSessionId = partSessionId || eventSessionId;
    if (ownerSessionId !== input.sessionId) return;

    const toolPart = part as ToolPart;
    const stateRecord = asRecord(toolPart.state);
    if (!stateRecord) return;

    const partId = readString(partRecord, "id");
    if (!partId) return;

    const timestamp = readNumber(properties, "time") ?? Date.now();
    const status = mapToolStatus(readString(stateRecord, "status"));
    const inputSummary = summarizeValue(stateRecord.input);
    const outputSummary =
      status === "completed"
        ? summarizeValue(stateRecord.output)
        : status === "error"
          ? summarizeValue(stateRecord.error)
          : "";

    const title = toolPart.tool?.trim() ? toolPart.tool.trim() : "Tool";
    const existingId = toolEntryByPartId.get(partId) ?? null;

    if (!existingId) {
      const entryId = createEntryId();
      toolEntryByPartId.set(partId, entryId);
      addEntry({
        id: entryId,
        source: "tool",
        sessionId: input.sessionId,
        timestamp,
        title,
        status,
        inputSummary,
        outputSummary,
        toolName: title,
        callId: readString(partRecord, "callID") || undefined,
      });
      return;
    }

    updateEntry(existingId, (current) => ({
      ...current,
      timestamp,
      status,
      inputSummary: inputSummary || current.inputSummary,
      outputSummary: outputSummary || current.outputSummary,
      title: title || current.title,
      toolName: title || current.toolName,
      callId: readString(partRecord, "callID") || current.callId,
    }));
  };

  const buildPtyCommand = (info: UnknownRecord) => {
    const command = readString(info, "command");
    const argsRaw = info.args;
    const args = Array.isArray(argsRaw) ? argsRaw.filter((item): item is string => typeof item === "string") : [];
    return [command, ...args].filter(Boolean).join(" ").trim();
  };

  const handlePtyCreatedOrUpdated = (properties: UnknownRecord) => {
    const info = asRecord(properties.info);
    if (!info) return;
    const ptyId = readString(info, "id");
    if (!ptyId) return;

    const title = readString(info, "title") || "Shell command";
    const commandSummary = buildPtyCommand(info);
    const statusText = readString(info, "status");
    const status: AuditEntryStatus =
      statusText === "running" ? "running" : statusText === "exited" ? "completed" : "pending";
    const timestamp = Date.now();
    const existingId = ptyEntryById.get(ptyId) ?? null;

    if (!existingId) {
      const entryId = createEntryId();
      ptyEntryById.set(ptyId, entryId);
      addEntry({
        id: entryId,
        source: "pty",
        sessionId: input.sessionId,
        timestamp,
        title,
        status,
        inputSummary: commandSummary,
        outputSummary: "",
        ptyId,
      });
      return;
    }

    updateEntry(existingId, (current) => ({
      ...current,
      timestamp,
      title: title || current.title,
      status,
      inputSummary: commandSummary || current.inputSummary,
    }));
  };

  const handlePtyExited = (properties: UnknownRecord) => {
    const ptyId = readString(properties, "id");
    if (!ptyId) return;
    const exitCode = readNumber(properties, "exitCode");
    const existingId = ptyEntryById.get(ptyId) ?? null;
    const timestamp = Date.now();
    const outputSummary = exitCode === null ? "Exited" : `Exited with code ${exitCode}`;
    const status: AuditEntryStatus = exitCode === null || exitCode === 0 ? "completed" : "error";

    if (!existingId) {
      const entryId = createEntryId();
      ptyEntryById.set(ptyId, entryId);
      addEntry({
        id: entryId,
        source: "pty",
        sessionId: input.sessionId,
        timestamp,
        title: "Shell command",
        status,
        inputSummary: "",
        outputSummary,
        ptyId,
      });
      return;
    }

    updateEntry(existingId, (current) => ({
      ...current,
      timestamp,
      status,
      outputSummary,
    }));
  };

  const handleSessionError = (properties: UnknownRecord) => {
    const sessionId = readString(properties, "sessionID");
    if (sessionId && sessionId !== input.sessionId) return;

    const message = getErrorMessage(properties.error) || "Session failed";
    addEntry({
      id: createEntryId(),
      source: "session-error",
      sessionId: input.sessionId,
      timestamp: Date.now(),
      title: "Session error",
      status: "error",
      inputSummary: "",
      outputSummary: summarizeValue(message),
    });
  };

  const hydrateFromSessionHistory = async (client: ReturnType<typeof createClient>) => {
    try {
      const response = await client.session.messages({ sessionID: input.sessionId, limit: 200 });
      const responseRecord = asRecord(response);
      const messagesRaw = responseRecord?.data;
      if (!Array.isArray(messagesRaw)) return;
      for (const message of messagesRaw) {
        const messageRecord = asRecord(message);
        const partsRaw = messageRecord?.parts;
        if (!Array.isArray(partsRaw)) continue;
        for (const part of partsRaw) {
          const partRecord = asRecord(part);
          if (!partRecord) continue;
          if (readString(partRecord, "type") !== "tool") continue;
          const timeRecord = asRecord(asRecord(partRecord.state)?.time);
          const time = readNumber(timeRecord ?? {}, "start") ?? Date.now();
          handleToolPartUpdated({
            sessionID: input.sessionId,
            part,
            time,
          });
        }
      }
    } catch {
      // Non-fatal: realtime SSE updates still flow when available.
    }
  };

  const start = async () => {
    const client = createClient(input.opencodeBaseUrl, undefined, {
      token: input.openworkToken,
      mode: "openwork",
    });

    try {
      const subscription = await client.event.subscribe(undefined, { signal: abortController.signal });
      setSnapshotSilently((current) => ({ ...current, connected: true, error: null }));
      await hydrateFromSessionHistory(client);

      for await (const raw of subscription.stream) {
        if (disposed || abortController.signal.aborted) return;
        const event = normalizeEvent(raw);
        if (!event) continue;
        const properties = asRecord(event.properties);
        if (!properties) continue;

        if (event.type === "message.part.updated") {
          handleToolPartUpdated(properties);
          continue;
        }
        if (event.type === "pty.created" || event.type === "pty.updated") {
          handlePtyCreatedOrUpdated(properties);
          continue;
        }
        if (event.type === "pty.exited") {
          handlePtyExited(properties);
          continue;
        }
        if (event.type === "session.error") {
          handleSessionError(properties);
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Failed to subscribe to audit events.";
      setSnapshotSilently((current) => ({ ...current, connected: false, error: message }));
    } finally {
      if (!disposed) {
        setSnapshotSilently((current) => ({ ...current, connected: false }));
      }
    }
  };
  const ensureStarted = () => {
    if (started || disposed) return;
    started = true;
    void start();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      ensureStarted();
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      abortController.abort();
      listeners.clear();
    },
  };
}
