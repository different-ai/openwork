import type { EngineEvent } from "./events.js";
import type {
  Agent,
  AgentPartInput,
  AssistantMessage,
  Auth,
  Command,
  Config,
  FilePartInput,
  GlobalHealthResponse,
  LspStatus,
  McpLocalConfig,
  McpRemoteConfig,
  McpStatus,
  McpStatusMap,
  Message,
  MessageWithParts,
  OutputFormat,
  PartInput,
  Path,
  PermissionReply,
  PermissionRequest,
  PermissionV2Reply,
  PermissionV2Request,
  Project,
  ProviderAuthAuthorization,
  ProviderAuthResponse,
  ProviderListResponse,
  QuestionAnswer,
  QuestionRequest,
  Session,
  SessionMessagesResponse,
  SessionStatusResponse,
  Todo,
  ToolIds,
  ToolList,
  VcsInfo,
} from "./types.js";

export type MaybePromise<T> = T | Promise<T>;

export type EngineLocation = {
  directory?: string;
  workspace?: string;
};

export type EngineCapabilities = {
  durableResume: boolean;
  backgroundSubagents: boolean;
  runtimeMcp: boolean;
  providerAuth: boolean;
  approvals: boolean;
  questions: boolean;
};

export type SessionIdInput = EngineLocation & {
  sessionID: string;
};

export type SessionListInput = EngineLocation & {
  scope?: "project";
  path?: string;
  roots?: boolean | "true" | "false";
  start?: number;
  search?: string;
  limit?: number;
};

export type SessionCreateInput = EngineLocation & {
  parentID?: string;
  title?: string;
  agent?: string;
  model?: {
    id: string;
    providerID: string;
    variant?: string;
  };
  metadata?: Record<string, unknown>;
  permission?: Session["permission"];
  workspaceID?: string;
};

export type SessionUpdateInput = SessionIdInput & {
  title?: string;
  metadata?: Record<string, unknown>;
  permission?: Session["permission"];
  time?: {
    archived?: number;
  };
};

export type SessionMessagesInput = SessionIdInput & {
  limit?: number;
  before?: string;
};

export type SessionPromptInput = SessionIdInput & {
  messageID?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  agent?: string;
  noReply?: boolean;
  tools?: Record<string, boolean>;
  format?: OutputFormat;
  system?: string;
  variant?: string;
  parts?: Array<PartInput>;
};

export type SessionCommandInput = SessionIdInput & {
  messageID?: string;
  agent?: string;
  model?: string;
  arguments?: string;
  command?: string;
  variant?: string;
  parts?: Array<FilePartInput>;
};

export type SessionShellInput = SessionIdInput & {
  messageID?: string;
  agent?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  command?: string;
};

export type SessionForkInput = SessionIdInput & {
  messageID?: string;
};

export type SessionRevertInput = SessionIdInput & {
  messageID?: string;
  partID?: string;
};

export type ConfigUpdateInput = EngineLocation & {
  config?: Config;
};

export type AuthSetInput = {
  providerID: string;
  auth?: Auth;
};

export type ProviderOauthAuthorizeInput = EngineLocation & {
  providerID: string;
  method?: number;
  inputs?: Record<string, string>;
};

export type ProviderOauthCallbackInput = EngineLocation & {
  providerID: string;
  method?: number;
  code?: string;
};

export type McpAddInput = EngineLocation & {
  name?: string;
  config?: McpLocalConfig | McpRemoteConfig;
};

export type McpNameInput = EngineLocation & {
  name: string;
};

export type McpAuthCallbackInput = McpNameInput & {
  code?: string;
};

export type PermissionReplyInput = EngineLocation & {
  requestID: string;
  reply?: PermissionReply;
  message?: string;
};

export type PermissionV2ReplyInput = {
  sessionID: string;
  requestID: string;
  reply?: PermissionV2Reply;
  message?: string;
};

export type QuestionReplyInput = EngineLocation & {
  requestID: string;
  answers?: Array<QuestionAnswer>;
};

export type ToolListInput = EngineLocation & {
  provider: string;
  model: string;
};

export type EngineEventSubscribeInput = EngineLocation;

export type EngineSessionAdapter = {
  list(input?: SessionListInput): MaybePromise<Array<Session>>;
  get(input: SessionIdInput): MaybePromise<Session>;
  messages(input: SessionMessagesInput): MaybePromise<SessionMessagesResponse>;
  todo(input: SessionIdInput): MaybePromise<Array<Todo>>;
  status(input?: EngineLocation): MaybePromise<SessionStatusResponse>;
  create(input?: SessionCreateInput): MaybePromise<Session>;
  update(input: SessionUpdateInput): MaybePromise<Session>;
  command(input: SessionCommandInput): MaybePromise<MessageWithParts<AssistantMessage>>;
  promptAsync(input: SessionPromptInput): MaybePromise<void>;
  revert(input: SessionRevertInput): MaybePromise<Session>;
  unrevert(input: SessionIdInput): MaybePromise<Session>;
  shell(input: SessionShellInput): MaybePromise<MessageWithParts<Message>>;
  fork(input: SessionForkInput): MaybePromise<Session>;
  delete(input: SessionIdInput): MaybePromise<boolean>;
  abort(input: SessionIdInput): MaybePromise<boolean>;
};

export type EngineConfigAdapter = {
  get(input?: EngineLocation): MaybePromise<Config>;
  update(input?: ConfigUpdateInput): MaybePromise<Config>;
};

export type EngineProviderAdapter = {
  list(input?: EngineLocation): MaybePromise<ProviderListResponse>;
  auth(input?: EngineLocation): MaybePromise<ProviderAuthResponse>;
  oauth: {
    authorize(input: ProviderOauthAuthorizeInput): MaybePromise<ProviderAuthAuthorization>;
    callback(input: ProviderOauthCallbackInput): MaybePromise<boolean>;
  };
};

export type EngineAuthAdapter = {
  set(input: AuthSetInput): MaybePromise<boolean>;
};

export type EngineMcpAdapter = {
  status(input?: EngineLocation): MaybePromise<McpStatusMap>;
  add(input?: McpAddInput): MaybePromise<McpStatusMap>;
  connect(input: McpNameInput): MaybePromise<boolean>;
  disconnect(input: McpNameInput): MaybePromise<boolean>;
  auth: {
    start(input: McpNameInput): MaybePromise<{ authorizationUrl: string; oauthState: string }>;
    callback(input: McpAuthCallbackInput): MaybePromise<McpStatus>;
    authenticate(input: McpNameInput): MaybePromise<McpStatus>;
    remove(input: McpNameInput): MaybePromise<{ success: true }>;
  };
};

export type EnginePermissionAdapter = {
  list(input?: EngineLocation): MaybePromise<Array<PermissionRequest>>;
  reply(input: PermissionReplyInput): MaybePromise<boolean>;
  v2: {
    list(input: SessionIdInput): MaybePromise<Array<PermissionV2Request>>;
    reply(input: PermissionV2ReplyInput): MaybePromise<boolean>;
  };
};

export type EngineQuestionAdapter = {
  list(input?: EngineLocation): MaybePromise<Array<QuestionRequest>>;
  reply(input: QuestionReplyInput): MaybePromise<boolean>;
  reject(input: EngineLocation & { requestID: string }): MaybePromise<boolean>;
};

export type EngineMetaAdapter = {
  agents: {
    list(input?: EngineLocation): MaybePromise<Array<Agent>>;
  };
  project: {
    list(input?: EngineLocation): MaybePromise<Array<Project>>;
  };
  path: {
    get(input?: EngineLocation): MaybePromise<Path>;
  };
  vcs: {
    get(input?: EngineLocation): MaybePromise<VcsInfo>;
  };
  lsp: {
    status(input?: EngineLocation): MaybePromise<Array<LspStatus>>;
  };
  command: {
    list(input?: EngineLocation): MaybePromise<Array<Command>>;
  };
  global: {
    health(): MaybePromise<GlobalHealthResponse>;
  };
  tool: {
    list(input: ToolListInput): MaybePromise<ToolList>;
    ids(input?: EngineLocation): MaybePromise<ToolIds>;
  };
};

export type EngineEventAdapter = {
  subscribe(input?: EngineEventSubscribeInput): MaybePromise<AsyncIterable<EngineEvent>>;
};

export type EngineAdapter = {
  capabilities(): MaybePromise<EngineCapabilities>;
  sessions: EngineSessionAdapter;
  config: EngineConfigAdapter;
  providers: EngineProviderAdapter;
  auth: EngineAuthAdapter;
  mcp: EngineMcpAdapter;
  permissions: EnginePermissionAdapter;
  questions: EngineQuestionAdapter;
  meta: EngineMetaAdapter;
  events: EngineEventAdapter;
};

export type { AgentPartInput };
