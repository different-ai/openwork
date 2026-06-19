import type { ToolUIPart, DynamicToolUIPart } from "ai";

export interface ToolMetadata {
  truncated?: boolean;
  outputPath?: string;
}

export interface InvalidInput {
  tool: string;
  error: string;
}

export interface InvalidMetadata extends ToolMetadata {}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionPrompt {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
}

export interface QuestionInput {
  questions: QuestionPrompt[];
}

export interface QuestionMetadata extends ToolMetadata {
  answers: string[][];
}

export interface EnvVarRequestInput {
  key: string;
  label?: string;
  description?: string;
  placeholder?: string;
  helpUrl?: string;
  followUpPrompt?: string;
}

export interface BashInput {
  command: string;
  timeout?: number;
  workdir?: string;
  description: string;
}

export interface BashMetadata extends ToolMetadata {
  output: string;
  exit: number | null;
  description: string;
  truncated: boolean;
}

export interface ReadInput {
  filePath: string;
  offset?: number;
  limit?: number;
}

export interface ReadMetadata extends ToolMetadata {
  preview: string;
  truncated: boolean;
  loaded: string[];
}

export interface GlobInput {
  pattern: string;
  path?: string;
}

export interface GlobMetadata extends ToolMetadata {
  count: number;
  truncated: boolean;
}

export interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
}

export interface GrepMetadata extends ToolMetadata {
  matches: number;
  truncated: boolean;
}

export interface FileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
}

export interface EditInput {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface EditMetadata extends ToolMetadata {
  diagnostics: unknown;
  diff: string;
  filediff: FileDiff;
}

export interface WriteInput {
  content: string;
  filePath: string;
}

export interface WriteMetadata extends ToolMetadata {
  diagnostics: unknown;
  filepath: string;
  exists: boolean;
}

export interface TaskModel {
  modelID: string;
  providerID: string;
}

export interface TaskInput {
  description: string;
  prompt: string;
  subagent_type: string;
  task_id?: string;
  command?: string;
  background?: boolean;
}

export interface TaskMetadata extends ToolMetadata {
  parentSessionId: string;
  sessionId: string;
  model: TaskModel;
  background?: true;
  jobId?: string;
}

export type TaskStatusState = "running" | "completed" | "error" | "cancelled";

export interface TaskStatusInput {
  task_id: string;
  wait?: boolean;
  timeout_ms?: number;
}

export interface TaskStatusMetadata extends ToolMetadata {
  task_id: string;
  state: TaskStatusState;
  timed_out: boolean;
}

export type WebFetchFormat = "text" | "markdown" | "html";

export interface WebFetchInput {
  url: string;
  format?: WebFetchFormat;
  timeout?: number;
}

export interface WebFetchMetadata extends ToolMetadata {}

export interface TodoItem {
  content: string;
  status: string;
  priority: string;
}

export interface TodoWriteInput {
  todos: TodoItem[];
}

export interface TodoWriteMetadata extends ToolMetadata {
  todos: TodoItem[];
}

export type WebSearchLivecrawl = "fallback" | "preferred";
export type WebSearchType = "auto" | "fast" | "deep";
export type WebSearchProvider = "exa" | "parallel";

export interface WebSearchInput {
  query: string;
  numResults?: number;
  livecrawl?: WebSearchLivecrawl;
  type?: WebSearchType;
  contextMaxCharacters?: number;
}

export interface WebSearchMetadata extends ToolMetadata {
  provider: WebSearchProvider;
}

export type RepoCloneStatus = "cached" | "cloned" | "refreshed";

export interface RepoCloneInput {
  repository: string;
  refresh?: boolean;
  branch?: string;
}

export interface RepoCloneMetadata extends ToolMetadata {
  repository: string;
  host: string;
  remote: string;
  localPath: string;
  status: RepoCloneStatus;
  head?: string;
  branch?: string;
}

export interface RepoOverviewInput {
  repository?: string;
  path?: string;
  depth?: number;
}

export interface RepoOverviewMetadata extends ToolMetadata {
  path: string;
  repository?: string;
  branch?: string;
  head?: string;
  package_manager?: string;
  ecosystems: string[];
  dependency_files: string[];
  entrypoints: string[];
  depth: number;
  truncated: boolean;
}

export interface SkillInput {
  name: string;
}

export interface SkillMetadata extends ToolMetadata {
  name: string;
  dir: string;
}

export interface ApplyPatchInput {
  patchText: string;
}

export type ApplyPatchFileType = "add" | "update" | "delete" | "move";

export interface ApplyPatchFile {
  filePath: string;
  relativePath: string;
  type: ApplyPatchFileType;
  patch: string;
  additions: number;
  deletions: number;
  movePath?: string;
}

export interface ApplyPatchMetadata extends ToolMetadata {
  diff: string;
  files: ApplyPatchFile[];
  diagnostics: unknown;
}

export type LspOperation =
  | "goToDefinition"
  | "findReferences"
  | "hover"
  | "documentSymbol"
  | "workspaceSymbol"
  | "goToImplementation"
  | "prepareCallHierarchy"
  | "incomingCalls"
  | "outgoingCalls";

export interface LspInput {
  operation: LspOperation;
  filePath: string;
  line: number;
  character: number;
  query?: string;
}

export interface LspMetadata extends ToolMetadata {
  result: unknown[];
}

export interface PlanExitInput {}

export interface PlanExitMetadata extends ToolMetadata {}

type BuiltInDynamicToolPart<ToolName extends string, Input, Output = string> =
  DynamicToolUIPart & { toolName: ToolName } & (
    | { state: "output-available"; input: Input; output: Output }
    | { state: "output-error"; input: Input; errorText: string }
    | {
        state: Exclude<DynamicToolUIPart["state"], "output-available" | "output-error">;
        input: Input;
      }
  );

export type BashToolPart = BuiltInDynamicToolPart<"bash", BashInput>;

export function isBashToolPart(part: ToolUIPart | DynamicToolUIPart): part is BashToolPart {
  return part.type === "dynamic-tool" && part.toolName === "bash";
}

export type EditToolPart = BuiltInDynamicToolPart<"edit", EditInput>;

export function isEditToolPart(part: ToolUIPart | DynamicToolUIPart): part is EditToolPart {
  return part.type === "dynamic-tool" && part.toolName === "edit";
}

export type WriteToolPart = BuiltInDynamicToolPart<"write", WriteInput>;

export function isWriteToolPart(part: ToolUIPart | DynamicToolUIPart): part is WriteToolPart {
  return part.type === "dynamic-tool" && part.toolName === "write";
}

export type ReadToolPart = BuiltInDynamicToolPart<"read", ReadInput>;

export function isReadToolPart(part: ToolUIPart | DynamicToolUIPart): part is ReadToolPart {
  return part.type === "dynamic-tool" && part.toolName === "read";
}

export type GrepToolPart = BuiltInDynamicToolPart<"grep", GrepInput>;

export function isGrepToolPart(part: ToolUIPart | DynamicToolUIPart): part is GrepToolPart {
  return part.type === "dynamic-tool" && part.toolName === "grep";
}

export type GlobToolPart = BuiltInDynamicToolPart<"glob", GlobInput>;

export function isGlobToolPart(part: ToolUIPart | DynamicToolUIPart): part is GlobToolPart {
  return part.type === "dynamic-tool" && part.toolName === "glob";
}

export type LspToolPart = BuiltInDynamicToolPart<"lsp", LspInput>;

export function isLspToolPart(part: ToolUIPart | DynamicToolUIPart): part is LspToolPart {
  return part.type === "dynamic-tool" && part.toolName === "lsp";
}

export type ApplyPatchToolPart = BuiltInDynamicToolPart<"apply_patch", ApplyPatchInput>;

export function isApplyPatchToolPart(part: ToolUIPart | DynamicToolUIPart): part is ApplyPatchToolPart {
  return part.type === "dynamic-tool" && part.toolName === "apply_patch";
}

export type SkillToolPart = BuiltInDynamicToolPart<"skill", SkillInput>;

export function isSkillToolPart(part: ToolUIPart | DynamicToolUIPart): part is SkillToolPart {
  return part.type === "dynamic-tool" && part.toolName === "skill";
}

export type TodoWriteToolPart = BuiltInDynamicToolPart<"todowrite", TodoWriteInput>;

export function isTodoWriteToolPart(part: ToolUIPart | DynamicToolUIPart): part is TodoWriteToolPart {
  return part.type === "dynamic-tool" && part.toolName === "todowrite";
}

export type WebFetchToolPart = BuiltInDynamicToolPart<"webfetch", WebFetchInput>;

export function isWebFetchToolPart(part: ToolUIPart | DynamicToolUIPart): part is WebFetchToolPart {
  return part.type === "dynamic-tool" && part.toolName === "webfetch";
}

export type WebSearchToolPart = BuiltInDynamicToolPart<"websearch", WebSearchInput>;

export function isWebSearchToolPart(part: ToolUIPart | DynamicToolUIPart): part is WebSearchToolPart {
  return part.type === "dynamic-tool" && part.toolName === "websearch";
}

export type QuestionToolPart = BuiltInDynamicToolPart<"question", QuestionInput>;

export function isQuestionToolPart(part: ToolUIPart | DynamicToolUIPart): part is QuestionToolPart {
  return part.type === "dynamic-tool" && part.toolName === "question";
}

export type EnvVarRequestToolPart = BuiltInDynamicToolPart<"request_env_var" | "env_var_request", EnvVarRequestInput, unknown>;

export function isEnvVarRequestToolPart(part: ToolUIPart | DynamicToolUIPart): part is EnvVarRequestToolPart {
  return part.type === "dynamic-tool" && (part.toolName === "request_env_var" || part.toolName === "env_var_request");
}

export type TaskToolPart = BuiltInDynamicToolPart<"task", TaskInput>;

export function isTaskToolPart(part: ToolUIPart | DynamicToolUIPart): part is TaskToolPart {
  return part.type === "dynamic-tool" && part.toolName === "task";
}
