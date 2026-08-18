export type JsonObject = Record<string, unknown>;

export type SnapshotFileDiff = {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
};

export type FileDiff = {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  patch: string;
};

export type PermissionAction = "allow" | "deny" | "ask";

export type PermissionRule = {
  permission: string;
  pattern: string;
  action: PermissionAction;
};

export type PermissionRuleset = Array<PermissionRule>;

// Full SDK shape: Session is central, small enough to own verbatim.
export type Session = {
  id: string;
  slug: string;
  projectID: string;
  workspaceID?: string;
  directory: string;
  path?: string;
  parentID?: string;
  summary?: {
    additions: number;
    deletions: number;
    files: number;
    diffs?: Array<SnapshotFileDiff>;
  };
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
  share?: {
    url: string;
  };
  title: string;
  agent?: string;
  model?: {
    id: string;
    providerID: string;
    variant?: string;
  };
  version: string;
  metadata?: JsonObject;
  time: {
    created: number;
    updated: number;
    compacting?: number;
    archived?: number;
  };
  permission?: PermissionRuleset;
  revert?: {
    messageID: string;
    partID?: string;
    snapshot?: string;
    diff?: string;
  };
};

export type OutputFormatText = {
  type: "text";
};

export type JsonSchema = JsonObject;

export type OutputFormatJsonSchema = {
  type: "json_schema";
  schema: JsonSchema;
  retryCount?: number;
};

export type OutputFormat = OutputFormatText | OutputFormatJsonSchema;

export type UserMessage = {
  id: string;
  sessionID: string;
  role: "user";
  time: {
    created: number;
  };
  format?: OutputFormat;
  summary?: {
    title?: string;
    body?: string;
    diffs: Array<SnapshotFileDiff>;
  };
  agent: string;
  model: {
    providerID: string;
    modelID: string;
    variant?: string;
  };
  system?: string;
  tools?: Record<string, boolean>;
};

export type ProviderAuthError = {
  name: "ProviderAuthError";
  data: {
    providerID: string;
    message: string;
  };
};

export type UnknownError = {
  name: "UnknownError";
  data: {
    message: string;
    ref?: string;
  };
};

export type MessageOutputLengthError = {
  name: "MessageOutputLengthError";
  data: JsonObject;
};

export type MessageAbortedError = {
  name: "MessageAbortedError";
  data: {
    message: string;
  };
};

export type StructuredOutputError = {
  name: "StructuredOutputError";
  data: {
    message: string;
    retries: number;
  };
};

export type ContextOverflowError = {
  name: "ContextOverflowError";
  data: {
    message: string;
    responseBody?: string;
  };
};

export type ContentFilterError = {
  name: "ContentFilterError";
  data: {
    message: string;
  };
};

export type ApiError = {
  name: "APIError";
  data: {
    message: string;
    statusCode?: number;
    isRetryable: boolean;
    responseHeaders?: Record<string, string>;
    responseBody?: string;
    metadata?: Record<string, string>;
  };
};

export type MessageError =
  | ProviderAuthError
  | UnknownError
  | MessageOutputLengthError
  | MessageAbortedError
  | StructuredOutputError
  | ContextOverflowError
  | ContentFilterError
  | ApiError;

export type AssistantMessage = {
  id: string;
  sessionID: string;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  error?: MessageError;
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  summary?: boolean;
  cost: number;
  tokens: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
  structured?: unknown;
  variant?: string;
  finish?: string;
};

// Full SDK shape: Message is small and used directly by the transcript cache.
export type Message = UserMessage | AssistantMessage;

export type TextPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: {
    start: number;
    end?: number;
  };
  metadata?: JsonObject;
};

export type SubtaskPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  command?: string;
};

export type ReasoningPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "reasoning";
  text: string;
  metadata?: JsonObject;
  time: {
    start: number;
    end?: number;
  };
};

export type FilePartSourceText = {
  value: string;
  start: number;
  end: number;
};

export type FileSource = {
  text: FilePartSourceText;
  type: "file";
  path: string;
};

export type Range = {
  start: {
    line: number;
    character: number;
  };
  end: {
    line: number;
    character: number;
  };
};

export type SymbolSource = {
  text: FilePartSourceText;
  type: "symbol";
  path: string;
  range: Range;
  name: string;
  kind: number;
};

export type ResourceSource = {
  text: FilePartSourceText;
  type: "resource";
  clientName: string;
  uri: string;
};

export type FilePartSource = FileSource | SymbolSource | ResourceSource;

export type FilePart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
};

export type ToolStatePending = {
  status: "pending";
  input: JsonObject;
  raw: string;
};

export type ToolStateRunning = {
  status: "running";
  input: JsonObject;
  title?: string;
  metadata?: JsonObject;
  time: {
    start: number;
  };
};

export type ToolStateCompleted = {
  status: "completed";
  input: JsonObject;
  output: string;
  title: string;
  metadata: JsonObject;
  time: {
    start: number;
    end: number;
    compacted?: number;
  };
  attachments?: Array<FilePart>;
};

export type ToolStateError = {
  status: "error";
  input: JsonObject;
  error: string;
  metadata?: JsonObject;
  time: {
    start: number;
    end: number;
  };
};

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export type ToolPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: JsonObject;
};

export type StepStartPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-start";
  snapshot?: string;
};

export type StepFinishPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-finish";
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
};

export type SnapshotPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "snapshot";
  snapshot: string;
};

export type PatchPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "patch";
  hash: string;
  files: Array<string>;
};

export type AgentPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "agent";
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
};

export type RetryPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "retry";
  attempt: number;
  error: ApiError;
  time: {
    created: number;
  };
};

export type CompactionPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "compaction";
  auto: boolean;
  overflow?: boolean;
  tail_start_id?: string;
};

// Full SDK shape: Part is the highest-risk UI discriminant, so every current variant is owned here.
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

export type PromptSource = {
  start: number;
  end: number;
  text: string;
};

export type PromptFileAttachment = {
  uri: string;
  mime: string;
  name?: string;
  description?: string;
  source?: PromptSource;
};

export type PromptAgentAttachment = {
  name: string;
  source?: PromptSource;
};

export type Prompt = {
  text: string;
  files?: Array<PromptFileAttachment>;
  agents?: Array<PromptAgentAttachment>;
};

export type TextPartInput = {
  id?: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: {
    start: number;
    end?: number;
  };
  metadata?: JsonObject;
};

export type FilePartInput = {
  id?: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
};

export type AgentPartInput = {
  id?: string;
  type: "agent";
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
};

export type SubtaskPartInput = {
  id?: string;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  command?: string;
};

export type PartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

export type Todo = {
  content: string;
  status: string;
  priority: string;
};

export type SessionStatus =
  | {
      type: "idle";
    }
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
  | {
      type: "busy";
    };

export type QuestionOption = {
  label: string;
  description: string;
};

export type QuestionInfo = {
  question: string;
  header: string;
  options: Array<QuestionOption>;
  multiple?: boolean;
  custom?: boolean;
};

export type QuestionTool = {
  messageID: string;
  callID: string;
};

export type QuestionAnswer = Array<string>;

export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: Array<QuestionInfo>;
  tool?: QuestionTool;
};

export type QuestionReplied = {
  sessionID: string;
  requestID: string;
  answers: Array<QuestionAnswer>;
};

export type QuestionRejected = {
  sessionID: string;
  requestID: string;
};

export type QuestionV2Option = QuestionOption;
export type QuestionV2Info = QuestionInfo;
export type QuestionV2Tool = QuestionTool;
export type QuestionV2Answer = QuestionAnswer;

export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: Array<string>;
  metadata: JsonObject;
  always: Array<string>;
  tool?: {
    messageID: string;
    callID: string;
  };
};

export type PermissionV2Source = {
  type: "tool";
  messageID: string;
  callID: string;
};

export type PermissionV2Reply = "once" | "always" | "reject";

export type PermissionV2Request = {
  id: string;
  sessionID: string;
  action: string;
  resources: Array<string>;
  save?: Array<string>;
  metadata?: JsonObject;
  source?: PermissionV2Source;
};

export type PermissionReply = "once" | "always" | "reject";

export type OAuth = {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
  enterpriseUrl?: string;
};

export type ApiAuth = {
  type: "api";
  key: string;
  metadata?: Record<string, string>;
};

export type WellKnownAuth = {
  type: "wellknown";
  key: string;
  token: string;
};

export type Auth = OAuth | ApiAuth | WellKnownAuth;

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type ServerConfig = {
  port?: number;
  hostname?: string;
  mdns?: boolean;
  mdnsDomain?: string;
  cors?: Array<string>;
};

export type PermissionActionConfig = "ask" | "allow" | "deny";
export type PermissionObjectConfig = Record<string, PermissionActionConfig>;
export type PermissionRuleConfig = PermissionActionConfig | PermissionObjectConfig;

export type PermissionConfig =
  | PermissionActionConfig
  | {
      read?: PermissionRuleConfig;
      edit?: PermissionRuleConfig;
      glob?: PermissionRuleConfig;
      grep?: PermissionRuleConfig;
      list?: PermissionRuleConfig;
      bash?: PermissionRuleConfig;
      task?: PermissionRuleConfig;
      external_directory?: PermissionRuleConfig;
      todowrite?: PermissionActionConfig;
      question?: PermissionActionConfig;
      webfetch?: PermissionActionConfig;
      websearch?: PermissionActionConfig;
      lsp?: PermissionRuleConfig;
      doom_loop?: PermissionActionConfig;
      skill?: PermissionRuleConfig;
    };

export type AgentConfig = {
  model?: string;
  variant?: string;
  temperature?: number;
  top_p?: number;
  prompt?: string;
  tools?: Record<string, boolean>;
  disable?: boolean;
  description?: string;
  mode?: "subagent" | "primary" | "all";
  hidden?: boolean;
  options?: JsonObject;
  color?: string;
  steps?: number;
  maxSteps?: number;
  permission?: PermissionConfig;
};

export type ProviderConfigModel = {
  id?: string;
  name?: string;
  family?: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  interleaved?: true | {
    field: "reasoning" | "reasoning_content" | "reasoning_details";
  };
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    context_over_200k?: {
      input: number;
      output: number;
      cache_read?: number;
      cache_write?: number;
    };
  };
  limit?: {
    context: number;
    input?: number;
    output: number;
  };
  modalities?: {
    input?: Array<"text" | "audio" | "image" | "video" | "pdf">;
    output?: Array<"text" | "audio" | "image" | "video" | "pdf">;
  };
  experimental?: boolean;
  status?: "alpha" | "beta" | "deprecated" | "active";
  provider?: {
    npm?: string;
    api?: string;
  };
  options?: JsonObject;
  headers?: Record<string, string>;
  variants?: Record<string, { disabled?: boolean } & JsonObject>;
};

export type ProviderConfig = {
  api?: string;
  name?: string;
  env?: Array<string>;
  id?: string;
  npm?: string;
  whitelist?: Array<string>;
  blacklist?: Array<string>;
  options?: {
    apiKey?: string;
    baseURL?: string;
    enterpriseUrl?: string;
    setCacheKey?: boolean;
    timeout?: number | false;
    headerTimeout?: number | false;
    chunkTimeout?: number;
  } & JsonObject;
  models?: Record<string, ProviderConfigModel>;
};

export type McpLocalConfig = {
  type: "local";
  command: Array<string>;
  cwd?: string;
  environment?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
};

export type McpOAuthConfig = {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  callbackPort?: number;
  redirectUri?: string;
};

export type McpRemoteConfig = {
  type: "remote";
  url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig | false;
  timeout?: number;
};

export type LayoutConfig = "auto" | "stretch";

export type ImageAttachmentConfig = {
  auto_resize?: boolean;
  max_width?: number;
  max_height?: number;
  max_base64_bytes?: number;
};

export type AttachmentConfig = {
  image?: ImageAttachmentConfig;
};

// Consumed subset: Config is broad and plugin-extensible. The app reads/writes these known fields.
export type Config = {
  $schema?: string;
  shell?: string;
  logLevel?: LogLevel;
  server?: ServerConfig;
  command?: Record<string, {
    template: string;
    description?: string;
    agent?: string;
    model?: string;
    variant?: string;
    subtask?: boolean;
  }>;
  skills?: {
    paths?: Array<string>;
    urls?: Array<string>;
  };
  references?: Record<string, string | ConfigV2ReferenceGit | ConfigV2ReferenceLocal>;
  reference?: Record<string, string | ConfigV2ReferenceGit | ConfigV2ReferenceLocal>;
  watcher?: {
    ignore?: Array<string>;
  };
  snapshot?: boolean;
  plugin?: Array<string | [string, JsonObject]>;
  share?: "manual" | "auto" | "disabled";
  autoshare?: boolean;
  autoupdate?: boolean | "notify";
  disabled_providers?: Array<string>;
  enabled_providers?: Array<string>;
  model?: string;
  small_model?: string;
  default_agent?: string;
  username?: string;
  mode?: Record<string, AgentConfig | undefined>;
  agent?: Record<string, AgentConfig | undefined>;
  provider?: Record<string, ProviderConfig>;
  mcp?: Record<string, McpLocalConfig | McpRemoteConfig | { enabled: boolean }>;
  formatter?: boolean | Record<string, {
    disabled?: boolean;
    command?: Array<string>;
    environment?: Record<string, string>;
    extensions?: Array<string>;
  }>;
  lsp?: boolean | Record<string, {
    disabled: true;
  } | {
    command: Array<string>;
    extensions?: Array<string>;
    disabled?: boolean;
    env?: Record<string, string>;
    initialization?: JsonObject;
  }>;
  instructions?: Array<string>;
  layout?: LayoutConfig;
  permission?: PermissionConfig;
  tools?: Record<string, boolean>;
  attachment?: AttachmentConfig;
  enterprise?: {
    url?: string;
  };
  tool_output?: {
    max_lines?: number;
    max_bytes?: number;
  };
  compaction?: {
    auto?: boolean;
    prune?: boolean;
    tail_turns?: number;
    preserve_recent_tokens?: number;
    reserved?: number;
  };
  experimental?: {
    disable_paste_summary?: boolean;
    batch_tool?: boolean;
    openTelemetry?: boolean;
    primary_tools?: Array<string>;
    continue_loop_on_deny?: boolean;
    mcp_timeout?: number;
    policies?: Array<ConfigV2ExperimentalPolicy>;
  };
};

export type ConfigV2ReferenceGit = {
  repository: string;
  branch?: string;
  description?: string;
  hidden?: boolean;
};

export type ConfigV2ReferenceLocal = {
  path: string;
  description?: string;
  hidden?: boolean;
};

export type PolicyEffect = "allow" | "deny";

export type ConfigV2ExperimentalPolicy = {
  action: "provider.use";
  effect: PolicyEffect;
  resource: string;
};

// Full SDK shape: provider/model list is displayed by the picker and den provider flows.
export type Model = {
  id: string;
  providerID: string;
  api: {
    id: string;
    url: string;
    npm: string;
  };
  name: string;
  family?: string;
  capabilities: {
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    toolcall: boolean;
    input: {
      text: boolean;
      audio: boolean;
      image: boolean;
      video: boolean;
      pdf: boolean;
    };
    output: {
      text: boolean;
      audio: boolean;
      image: boolean;
      video: boolean;
      pdf: boolean;
    };
    interleaved: boolean | {
      field: "reasoning" | "reasoning_content" | "reasoning_details";
    };
  };
  cost: {
    input: number;
    output: number;
    cache: {
      read: number;
      write: number;
    };
    tiers?: Array<{
      input: number;
      output: number;
      cache: {
        read: number;
        write: number;
      };
      tier: {
        type: "context";
        size: number;
      };
    }>;
    experimentalOver200K?: {
      input: number;
      output: number;
      cache: {
        read: number;
        write: number;
      };
    };
  };
  limit: {
    context: number;
    input?: number;
    output: number;
  };
  status: "alpha" | "beta" | "deprecated" | "active";
  options: JsonObject;
  headers: Record<string, string>;
  release_date: string;
  variants?: Record<string, JsonObject>;
};

export type Provider = {
  id: string;
  name: string;
  source: "env" | "config" | "custom" | "api";
  env: Array<string>;
  key?: string;
  options: JsonObject;
  models: Record<string, Model>;
};

export type ProviderListResponse = {
  all: Array<Provider>;
  default: Record<string, string>;
  connected: Array<string>;
};

export type ProviderAuthMethod = {
  type: "oauth" | "api";
  label: string;
  prompts?: Array<{
    type: "text";
    key: string;
    message: string;
    placeholder?: string;
    when?: {
      key: string;
      op: "eq" | "neq";
      value: string;
    };
  } | {
    type: "select";
    key: string;
    message: string;
    options: Array<{
      label: string;
      value: string;
      hint?: string;
    }>;
    when?: {
      key: string;
      op: "eq" | "neq";
      value: string;
    };
  }>;
};

export type ProviderAuthResponse = Record<string, Array<ProviderAuthMethod>>;

export type ProviderAuthAuthorization = {
  url: string;
  method: "auto" | "code";
  instructions: string;
};

export type ToolListItem = {
  id: string;
  description: string;
  parameters: unknown;
};

export type ToolList = Array<ToolListItem>;
export type ToolIds = Array<string>;

export type Agent = {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  native?: boolean;
  hidden?: boolean;
  topP?: number;
  temperature?: number;
  color?: string;
  permission: PermissionRuleset;
  model?: {
    modelID: string;
    providerID: string;
  };
  variant?: string;
  prompt?: string;
  options: JsonObject;
  steps?: number;
};

export type LspStatus = {
  id: string;
  name: string;
  root: string;
  status: "connected" | "error";
};

export type McpStatusConnected = {
  status: "connected";
};

export type McpStatusDisabled = {
  status: "disabled";
};

export type McpStatusFailed = {
  status: "failed";
  error: string;
};

export type McpStatusNeedsAuth = {
  status: "needs_auth";
};

export type McpStatusNeedsClientRegistration = {
  status: "needs_client_registration";
  error: string;
};

export type McpStatus =
  | McpStatusConnected
  | McpStatusDisabled
  | McpStatusFailed
  | McpStatusNeedsAuth
  | McpStatusNeedsClientRegistration;

export type McpStatusMap = Record<string, McpStatus>;

export type Project = {
  id: string;
  worktree: string;
  vcs?: "git";
  name?: string;
  icon?: {
    url?: string;
    override?: string;
    color?: string;
  };
  commands?: {
    start?: string;
  };
  time: {
    created: number;
    updated: number;
    initialized?: number;
  };
  sandboxes: Array<string>;
};

export type Path = {
  home: string;
  state: string;
  config: string;
  worktree: string;
  directory: string;
};

export type VcsInfo = {
  branch?: string;
  default_branch?: string;
};

export type Command = {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: "command" | "mcp" | "skill";
  template: string;
  subtask?: boolean;
  hints: Array<string>;
};

export type GlobalHealthResponse = {
  healthy: true;
  version: string;
};

export type MessageWithParts<TInfo extends Message = Message> = {
  info: TInfo;
  parts: Array<Part>;
};

export type SessionMessagesResponse = Array<MessageWithParts>;
export type SessionStatusResponse = Record<string, SessionStatus>;
export type SessionTodoResponse = Array<Todo>;
