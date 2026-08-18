import type {
  Message,
  MessageError,
  Part,
  PermissionReply,
  PermissionRequest,
  PermissionV2Reply,
  PermissionV2Request,
  QuestionAnswer,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "./types.js";

export type EngineEventBase<TType extends string, TProperties> = {
  id: string;
  type: TType;
  properties: TProperties;
};

export type EngineEvent =
  | EngineEventBase<"session.created", { sessionID: string; info: Session }>
  | EngineEventBase<"session.updated", { sessionID: string; info: Session }>
  | EngineEventBase<"session.deleted", { sessionID: string; info: Session }>
  | EngineEventBase<"message.updated", { sessionID: string; info: Message }>
  | EngineEventBase<"message.removed", { sessionID: string; messageID: string }>
  | EngineEventBase<"message.part.updated", { sessionID: string; part: Part; time: number }>
  | EngineEventBase<"message.part.delta", { sessionID: string; messageID: string; partID: string; field: string; delta: string }>
  | EngineEventBase<"session.error", { sessionID?: string; error?: MessageError }>
  | EngineEventBase<"session.next.compaction.started", { timestamp: number; sessionID: string; messageID: string; reason: "auto" | "manual" }>
  | EngineEventBase<"session.next.compaction.ended", { timestamp: number; sessionID: string; messageID: string; reason: "auto" | "manual"; text: string; recent: string }>
  | EngineEventBase<"session.compacted", { sessionID: string }>
  | EngineEventBase<"session.status", { sessionID: string; status: SessionStatus }>
  | EngineEventBase<"session.idle", { sessionID: string }>
  | EngineEventBase<"todo.updated", { sessionID: string; todos: Array<Todo> }>
  | EngineEventBase<"permission.asked", PermissionRequest>
  | EngineEventBase<"permission.replied", { sessionID: string; requestID: string; reply: PermissionReply }>
  | EngineEventBase<"permission.v2.asked", PermissionV2Request>
  | EngineEventBase<"permission.v2.replied", { sessionID: string; requestID: string; reply: PermissionV2Reply }>
  | EngineEventBase<"question.asked", QuestionRequest>
  | EngineEventBase<"question.replied", { sessionID: string; requestID: string; answers: Array<QuestionAnswer> }>
  | EngineEventBase<"question.rejected", { sessionID: string; requestID: string }>
  | EngineEventBase<"mcp.tools.changed", { server: string }>
  | EngineEventBase<"lsp.updated", Record<string, unknown>>;

export type EngineGlobalEventEnvelope = {
  directory: string;
  project?: string;
  workspace?: string;
  payload: EngineEvent;
};

export const engineEventTypes: ReadonlyArray<EngineEvent["type"]> = [
  "session.created",
  "session.updated",
  "session.deleted",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.delta",
  "session.error",
  "session.next.compaction.started",
  "session.next.compaction.ended",
  "session.compacted",
  "session.status",
  "session.idle",
  "todo.updated",
  "permission.asked",
  "permission.replied",
  "permission.v2.asked",
  "permission.v2.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "mcp.tools.changed",
  "lsp.updated",
];
