/**
 * The OpenCode shapes the app reads and renders. The v2 adapter
 * (`opencode-v2-adapter.ts`) maps native engine payloads into these, so they
 * are the app's own canonical session, message and catalog types rather than
 * an engine wire format.
 */

export type Session = {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  version: string;
  model?: { providerID: string; id: string; variant?: string };
  time: {
    created: number;
    updated: number;
    compacting?: number;
  };
  revert?: {
    messageID: string;
    partID?: string;
    snapshot?: string;
    diff?: string;
  };
};

export type SessionStatus =
  | { type: "idle" }
  | {
    type: "retry";
    attempt: number;
    message: string;
    action?: {
      reason: string;
      provider: string;
      title: string;
      message: string;
      label: string;
      link?: string;
    };
    next: number;
  }
  | { type: "busy" };

type MessageTokens = {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

type NamedError<Name extends string, Data = { message: string }> = { name: Name; data: Data };

export type UnknownError = NamedError<"UnknownError", { message: string; ref?: string }>;

export type ApiError = NamedError<"APIError", {
  message: string;
  statusCode?: number;
  isRetryable: boolean;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  metadata?: Record<string, string>;
}>;

type MessageError =
  | NamedError<"ProviderAuthError", { providerID: string; message: string }>
  | UnknownError
  | NamedError<"MessageOutputLengthError", Record<string, unknown>>
  | NamedError<"MessageAbortedError">
  | NamedError<"StructuredOutputError", { message: string; retries: number }>
  | NamedError<"ContextOverflowError", { message: string; responseBody?: string }>
  | NamedError<"ContentFilterError">
  | ApiError;

/**
 * One conversation turn. A user turn carries its words in parts; an assistant
 * reply names the model that answered and, once the engine reports it, the
 * user turn it answers.
 */
export type Message = {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | "system";
  time: { created: number; completed?: number };
  error?: MessageError;
  parentID?: string;
  agent?: string;
  model?: { id?: string; modelID?: string; providerID: string; variant?: string };
  modelID?: string;
  providerID?: string;
  resolvedModel?: { id: string; providerID?: string; name?: string };
  mode?: string;
  cost?: number;
  tokens?: MessageTokens;
  finish?: string;
  summary?: boolean;
  variant?: string;
};

type PartBase = {
  id: string;
  sessionID: string;
  messageID: string;
};

type PartSourceText = { value: string; start: number; end: number };

type FilePartSource =
  | { type: "file"; text: PartSourceText; path: string }
  | {
    type: "symbol";
    text: PartSourceText;
    path: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    name: string;
    kind: number;
  }
  | { type: "resource"; text: PartSourceText; clientName: string; uri: string };

export type TextPart = PartBase & {
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: Record<string, unknown>;
};

export type ReasoningPart = PartBase & {
  type: "reasoning";
  text: string;
  metadata?: Record<string, unknown>;
  time: { start: number; end?: number };
};

export type FilePart = PartBase & {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
};

type ToolState =
  | { status: "pending"; input: Record<string, unknown>; raw: string }
  | {
    status: "running";
    input: Record<string, unknown>;
    title?: string;
    metadata?: Record<string, unknown>;
    time: { start: number };
  }
  | {
    status: "completed";
    input: Record<string, unknown>;
    output: string;
    title: string;
    metadata: Record<string, unknown>;
    time: { start: number; end: number; compacted?: number };
    attachments?: FilePart[];
  }
  | {
    status: "error";
    input: Record<string, unknown>;
    error: string;
    metadata?: Record<string, unknown>;
    time: { start: number; end: number };
  };

export type ToolPart = PartBase & {
  type: "tool";
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
};

type SubtaskPart = PartBase & {
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
  model?: { providerID: string; modelID: string };
  command?: string;
};

type StepStartPart = PartBase & { type: "step-start"; snapshot?: string };

type StepFinishPart = PartBase & {
  type: "step-finish";
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: MessageTokens;
};

type SnapshotPart = PartBase & { type: "snapshot"; snapshot: string };

type PatchPart = PartBase & { type: "patch"; hash: string; files: string[] };

type AgentPart = PartBase & { type: "agent"; name: string; source?: PartSourceText };

type RetryPart = PartBase & { type: "retry"; attempt: number; error: ApiError; time: { created: number } };

type CompactionPart = PartBase & { type: "compaction"; auto: boolean; overflow?: boolean };

export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart;

export type TextPartInput = Omit<TextPart, keyof PartBase> & { id?: string };
export type FilePartInput = Omit<FilePart, keyof PartBase> & { id?: string };
export type AgentPartInput = Omit<AgentPart, keyof PartBase> & { id?: string };

export type Todo = {
  content: string;
  status: string;
  priority: string;
};

export type QuestionInfo = {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiple?: boolean;
  custom?: boolean;
};

export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
};

export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
};

export type PermissionV2Request = {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: "tool"; messageID: string; callID: string };
};

type ModelModalities = {
  text: boolean;
  audio: boolean;
  image: boolean;
  video: boolean;
  pdf: boolean;
};

type ModelCost = {
  input: number;
  output: number;
  cache: { read: number; write: number };
};

export type Model = {
  id: string;
  providerID: string;
  api: { id: string; url: string; npm: string };
  name: string;
  family?: string;
  capabilities: {
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    toolcall: boolean;
    input: ModelModalities;
    output: ModelModalities;
    interleaved: boolean | { field: string };
  };
  cost: ModelCost & { experimentalOver200K?: ModelCost };
  limit: { context: number; input?: number; output: number };
  status: "alpha" | "beta" | "deprecated" | "active";
  options: Record<string, unknown>;
  headers: Record<string, string>;
  release_date: string;
  variants?: Record<string, Record<string, unknown>>;
};

export type Provider = {
  id: string;
  name: string;
  source: "env" | "config" | "custom" | "api";
  env: string[];
  key?: string;
  options: Record<string, unknown>;
  models: Record<string, Model>;
};

export type ProviderListResponse = {
  all: Provider[];
  default: Record<string, string>;
  connected: string[];
};

export type ConfigProvidersResponse = {
  providers: Provider[];
  default: Record<string, string>;
};

/** A provider entry written into workspace configuration (`opencode.provider.<id>`). */
export type ProviderConfig = {
  api?: string;
  name?: string;
  env?: string[];
  id?: string;
  npm?: string;
  whitelist?: string[];
  blacklist?: string[];
  options?: { apiKey?: string; baseURL?: string; [key: string]: unknown };
  models?: Record<string, {
    id?: string;
    name?: string;
    family?: string;
    release_date?: string;
    attachment?: boolean;
    reasoning?: boolean;
    temperature?: boolean;
    tool_call?: boolean;
    interleaved?: boolean | string | { field: string };
    cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
    limit?: { context: number; input?: number; output: number };
    modalities?: {
      input?: ("text" | "audio" | "image" | "video" | "pdf")[];
      output?: ("text" | "audio" | "image" | "video" | "pdf")[];
    };
    status?: "alpha" | "beta" | "deprecated" | "active";
    options?: Record<string, unknown>;
    headers?: Record<string, string>;
    provider?: { npm?: string; api?: string };
    variants?: Record<string, { disabled?: boolean; [key: string]: unknown }>;
  }>;
};

/** A provider sign-in the person finishes in the browser. */
export type ProviderAuthAuthorization = {
  url: string;
  method: "auto" | "code";
  instructions: string;
};

export type Agent = {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  native?: boolean;
  hidden?: boolean;
  color?: string;
  permission: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[];
  model?: { modelID: string; providerID: string };
  variant?: string;
  options: Record<string, unknown>;
};

/** One way to connect an integration (a model provider or a connection). */
export type IntegrationMethod =
  | { type: "oauth"; id: string; label: string }
  | { type: "key"; label?: string }
  | { type: "env"; names: string[] };

/** A connectable integration and the credentials it holds now. */
export type IntegrationInfo = {
  id: string;
  name: string;
  methods: IntegrationMethod[];
  connections: Array<{ type: "credential"; id: string; label: string } | { type: "env"; name: string }>;
};

/** A browser sign-in the engine started for an integration. */
export type IntegrationAttempt = {
  attemptID: string;
  url: string;
  instructions: string;
  mode: "auto" | "code";
};

export type IntegrationAttemptStatus =
  | { status: "pending" | "complete" | "expired" }
  | { status: "failed"; message: string };
