/**
 * OpenWork-owned semantic types for the workspace-scoped session read API.
 *
 * These intentionally preserve the current wire surface so the OpenWork app
 * can stop importing the engine SDK without forcing a response migration.
 * Vendor response validation remains the server adapter's responsibility.
 */

export type OpenWorkSessionFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export type OpenWorkSession = {
  id: string
  slug: string
  projectID: string
  workspaceID?: string
  directory: string
  path?: string
  parentID?: string
  summary?: {
    additions: number
    deletions: number
    files: number
    diffs?: OpenWorkSessionFileDiff[]
  }
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  share?: { url: string }
  title: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  version: string
  metadata?: Record<string, unknown>
  time: {
    created: number
    updated: number
    compacting?: number
    archived?: number
  }
  permission?: Array<{
    permission: string
    pattern: string
    action: "allow" | "deny" | "ask"
  }>
  revert?: {
    messageID: string
    partID?: string
    snapshot?: string
    diff?: string
  }
}

export type OpenWorkUserSessionMessageInfo = {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  format?:
    | { type: "text" }
    | { type: "json_schema"; schema: Record<string, unknown>; retryCount?: number }
  summary?: {
    title?: string
    body?: string
    diffs: OpenWorkSessionFileDiff[]
  }
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
  system?: string
  tools?: Record<string, boolean>
}

export type OpenWorkSessionApiError = {
  name: "APIError"
  data: {
    message: string
    statusCode?: number
    isRetryable: boolean
    responseHeaders?: Record<string, string>
    responseBody?: string
    metadata?: Record<string, string>
  }
}

export type OpenWorkSessionMessageError =
  | {
      name: "ProviderAuthError"
      data: { providerID: string; message: string }
    }
  | {
      name: "UnknownError"
      data: { message: string; ref?: string }
    }
  | {
      name: "MessageOutputLengthError"
      data: Record<string, unknown>
    }
  | {
      name: "MessageAbortedError"
      data: { message: string }
    }
  | {
      name: "StructuredOutputError"
      data: { message: string; retries: number }
    }
  | {
      name: "ContextOverflowError"
      data: { message: string; responseBody?: string }
    }
  | {
      name: "ContentFilterError"
      data: { message: string }
    }
  | OpenWorkSessionApiError

export type OpenWorkAssistantSessionMessageInfo = {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  error?: OpenWorkSessionMessageError
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: { cwd: string; root: string }
  summary?: boolean
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  structured?: unknown
  variant?: string
  finish?: string
}

export type OpenWorkSessionMessageInfo =
  | OpenWorkUserSessionMessageInfo
  | OpenWorkAssistantSessionMessageInfo

type OpenWorkSessionPartIdentity = {
  id: string
  sessionID: string
  messageID: string
}

export type OpenWorkTextSessionPart = OpenWorkSessionPartIdentity & {
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: { start: number; end?: number }
  metadata?: Record<string, unknown>
}

export type OpenWorkSubtaskSessionPart = OpenWorkSessionPartIdentity & {
  type: "subtask"
  prompt: string
  description: string
  agent: string
  model?: { providerID: string; modelID: string }
  command?: string
}

export type OpenWorkReasoningSessionPart = OpenWorkSessionPartIdentity & {
  type: "reasoning"
  text: string
  metadata?: Record<string, unknown>
  time: { start: number; end?: number }
}

export type OpenWorkFilePartSourceText = {
  value: string
  start: number
  end: number
}

export type OpenWorkFilePartSource =
  | {
      text: OpenWorkFilePartSourceText
      type: "file"
      path: string
    }
  | {
      text: OpenWorkFilePartSourceText
      type: "symbol"
      path: string
      range: {
        start: { line: number; character: number }
        end: { line: number; character: number }
      }
      name: string
      kind: number
    }
  | {
      text: OpenWorkFilePartSourceText
      type: "resource"
      clientName: string
      uri: string
    }

export type OpenWorkFileSessionPart = OpenWorkSessionPartIdentity & {
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: OpenWorkFilePartSource
}

export type OpenWorkToolSessionPartState =
  | {
      status: "pending"
      input: Record<string, unknown>
      raw: string
    }
  | {
      status: "running"
      input: Record<string, unknown>
      title?: string
      metadata?: Record<string, unknown>
      time: { start: number }
    }
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title: string
      metadata: Record<string, unknown>
      time: { start: number; end: number; compacted?: number }
      attachments?: OpenWorkFileSessionPart[]
    }
  | {
      status: "error"
      input: Record<string, unknown>
      error: string
      metadata?: Record<string, unknown>
      time: { start: number; end: number }
    }

export type OpenWorkToolSessionPart = OpenWorkSessionPartIdentity & {
  type: "tool"
  callID: string
  tool: string
  state: OpenWorkToolSessionPartState
  metadata?: Record<string, unknown>
}

export type OpenWorkSessionPart =
  | OpenWorkTextSessionPart
  | OpenWorkSubtaskSessionPart
  | OpenWorkReasoningSessionPart
  | OpenWorkFileSessionPart
  | OpenWorkToolSessionPart
  | (OpenWorkSessionPartIdentity & { type: "step-start"; snapshot?: string })
  | (OpenWorkSessionPartIdentity & {
      type: "step-finish"
      reason: string
      snapshot?: string
      cost: number
      tokens: {
        total?: number
        input: number
        output: number
        reasoning: number
        cache: { read: number; write: number }
      }
    })
  | (OpenWorkSessionPartIdentity & { type: "snapshot"; snapshot: string })
  | (OpenWorkSessionPartIdentity & { type: "patch"; hash: string; files: string[] })
  | (OpenWorkSessionPartIdentity & {
      type: "agent"
      name: string
      source?: { value: string; start: number; end: number }
    })
  | (OpenWorkSessionPartIdentity & {
      type: "retry"
      attempt: number
      error: OpenWorkSessionApiError
      time: { created: number }
    })
  | (OpenWorkSessionPartIdentity & {
      type: "compaction"
      auto: boolean
      overflow?: boolean
      tail_start_id?: string
    })

export type OpenWorkSessionMessage = {
  info: OpenWorkSessionMessageInfo
  parts: OpenWorkSessionPart[]
}

export type OpenWorkSessionTodo = {
  content: string
  status: string
  priority: string
}

export type OpenWorkSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number }

export type OpenWorkSessionSnapshot = {
  session: OpenWorkSession
  messages: OpenWorkSessionMessage[]
  todos: OpenWorkSessionTodo[]
  status: OpenWorkSessionStatus
}
