import { Ajv } from "ajv";
import sendSchema from "../schema/send.json" with { type: "json" };
import contractSchema from "../schema/contract.json" with { type: "json" };
export type Platform = "macos" | "linux";
export type Phase =
  | "idle"
  | "running"
  | "stopping"
  | "waitingApproval"
  | "error"
  | "unknown";
export interface Capabilities {
  readSessions: boolean;
  readMessages: boolean;
  readStatus: boolean;
  events: boolean;
  createSession: boolean;
  sendText: boolean;
  stop: boolean;
  readApprovals: boolean;
  replyApproval: boolean;
  maxPromptBytes: number;
  protocolVersion: number;
  modelSettings?: boolean;
  renameSession?: boolean;
  savedPermissions?: boolean;
}
export interface ModelSelection {
  providerId: string;
  modelId: string;
  variant: string | null;
}
export interface ModelOption {
  providerId: string;
  modelId: string;
  name: string;
  variants: string[];
}
export interface ModelSettings {
  current: ModelSelection;
  models: ModelOption[];
  revision: string;
}
export interface SavedPermission {
  id: string;
  action: string;
  resource: string;
  revision: string;
}
export interface SavedPermissions {
  grants: SavedPermission[];
  modeSupported: boolean;
  modeReason: string;
}
export interface Host {
  hostId: string;
  displayName: string;
  platform: Platform;
  architecture: string;
  runtimeKind: "desktop" | "standalone";
  protocolVersion: number;
  upstreamVersion: string;
  compatibility: "supported" | "incompatible" | "unavailable";
  capabilities: Capabilities;
}
export interface Workspace {
  id: string;
  name: string;
}
export interface Session {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt: string;
  modelLabel: string | null;
  status: Phase;
}
export type Block =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string; language: string | null }
  | { kind: "tool"; name: string; status: string; summary: string }
  | { kind: "omitted"; label: string }
  | { kind: "unsupported"; label: string };
export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  blocks: Block[];
  state: "streaming" | "complete" | "error" | "cancelled";
}
export interface SessionStatus {
  phase: Phase;
  observedAt: string;
  activeTurnId: string | null;
  errorCode: string | null;
}
export interface Approval {
  id: string;
  sessionId: string;
  kind: string;
  title: string;
  details: string;
  revision: string;
  supportedDecisions: ("allowOnce" | "deny")[];
  createdAt: string;
}
export interface MutationReceipt {
  requestId: string;
  resourceId: string | null;
  state: "pending" | "accepted" | "confirmed" | "rejected" | "outcome_unknown";
  observedAt: string;
}
export interface Page<T> {
  data: T;
  cursor: string | null;
}
export class BridgeError extends Error {
  constructor(
    public code: string,
    public status = 503,
    public retryable = false,
  ) {
    super(code);
    this.name = "BridgeError";
  }
}
export class PreflightError extends BridgeError {}
const contractAjv = new Ajv({ allErrors: false });
contractAjv.addSchema(contractSchema);
const validators = new Map(
  Object.keys(contractSchema.$defs).map((key) => [
    key,
    contractAjv.compile({ $ref: contractSchema.$id + "#/$defs/" + key }),
  ]),
);
export function assertContract<T>(type: string, value: T): T {
  const validate = validators.get(type);
  if (!validate || !validate(value))
    throw new BridgeError("INVALID_UPSTREAM", 502);
  return value;
}
export function parseApprovalReply(value: unknown): {
  requestId: string;
  decision: "allowOnce" | "deny";
  revision: string;
} {
  try {
    return assertContract("ApprovalReply", value) as any;
  } catch {
    throw new BridgeError("INVALID_REQUEST", 400);
  }
}
const validateSend = new Ajv({ allErrors: false }).compile(sendSchema);
export function parseSend(value: unknown): { requestId: string; text: string } {
  if (!validateSend(value)) throw new BridgeError("INVALID_REQUEST", 400);
  const v = value as { requestId: string; text: string };
  if (Buffer.byteLength(v.text, "utf8") > 32768)
    throw new BridgeError("PROMPT_TOO_LARGE", 413);
  return v;
}
export function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function normalizeBlock(v: unknown): Block {
  if (!record(v))
    return { kind: "unsupported", label: "Content available on computer" };
  if (
    (v.type === "text" || v.type === "reasoning") &&
    typeof v.text === "string"
  )
    return Buffer.byteLength(v.text) > 1024 * 1024
      ? { kind: "omitted", label: "Large content available on computer" }
      : { kind: "text", text: v.text };
  if (v.type === "code" && typeof v.text === "string")
    return Buffer.byteLength(v.text) > 1024 * 1024
      ? { kind: "omitted", label: "Large content available on computer" }
      : {
          kind: "code",
          text: v.text,
          language:
            typeof v.language === "string" ? v.language.slice(0, 120) : null,
        };
  if (v.type === "tool" && typeof v.name === "string")
    return {
      kind: "tool",
      name: v.name.slice(0, 120),
      status: typeof v.state === "string" ? v.state : "unknown",
      summary: "Tool activity on computer",
    };
  return { kind: "unsupported", label: "Content available on computer" };
}
