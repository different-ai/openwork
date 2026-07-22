import * as Sentry from "@sentry/node"

export const DEBUG_PAYLOAD_ORGANIZATION_ID = "org_01krnrcabhe8htwpbnsw0zk0bw"

export type PayloadLogMode = "summary" | "full"

export type InferenceRequestReport = {
  organizationId: string
  orgMembershipId: string
  inferenceKeyId: string
  openworkRequestId: string
  route: string
  method: string
  incomingModel: string | null
  resolvedUpstreamModel: string | null
  headers: Record<string, string>
  payloadMode: PayloadLogMode
  payload: unknown
}

export type InferenceHandledErrorReport = {
  reason: string
  organizationId?: string
  orgMembershipId?: string
  inferenceKeyId?: string
  openworkRequestId?: string
  route: string
  method: string
  incomingModel?: string | null
  resolvedUpstreamModel?: string | null
  headers?: Record<string, string>
  status?: number
  statusText?: string
  upstreamUrl?: string
  error?: string
  exception?: unknown
}

export type InferenceReporter = {
  request(report: InferenceRequestReport): void
  handledError(report: InferenceHandledErrorReport): void
}

type PayloadLog = {
  mode: PayloadLogMode
  payload: unknown
}

const redactedValue = "[REDACTED]"
const exactCredentialFields = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "cookies",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "token",
  "tokens",
  "key",
  "apikey",
  "xapikey",
  "providerkey",
  "privatekey",
  "clientkey",
  "clientsecret",
  "dsn",
  "signature",
  "credential",
  "credentials",
  "encryptedapikey",
  "forwarded",
  "xforwardedfor",
  "xrealip",
  "cfconnectingip",
  "trueclientip",
])

const nonSecretTokenFields = new Set([
  "maxtokens",
  "prompttokens",
  "completiontokens",
  "totaltokens",
  "inputtokens",
  "outputtokens",
])

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeFieldName(field: string) {
  return field.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function shouldRedactField(field: string) {
  const normalized = normalizeFieldName(field)
  if (normalized.endsWith("keyid")) return false
  if (exactCredentialFields.has(normalized)) return true
  if (normalized.endsWith("dsn")) return true
  if (normalized.includes("password")) return true
  if (normalized.includes("passwd")) return true
  if (normalized.includes("secret")) return true
  if (normalized.includes("credential")) return true
  if (normalized.includes("authorization")) return true
  if (normalized.includes("cookie")) return true
  if (normalized.includes("signature")) return true
  if (!nonSecretTokenFields.has(normalized) && (normalized.endsWith("token") || normalized.endsWith("tokens"))) return true
  if (normalized.endsWith("key")) return true
  if (normalized.includes("apikey") && !normalized.endsWith("id")) return true
  if (normalized.includes("providerkey") && !normalized.endsWith("id")) return true
  return false
}

function redactJsonArgumentString(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    return JSON.stringify(redactCredentialFields(parsed))
  } catch {
    return value
  }
}

export function redactCredentialFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactCredentialFields(item))
  }

  if (!isJsonObject(value)) return value

  const redacted: Record<string, unknown> = {}
  for (const [field, child] of Object.entries(value)) {
    if (shouldRedactField(field)) {
      redacted[field] = redactedValue
      continue
    }

    redacted[field] = field === "arguments" && typeof child === "string"
      ? redactJsonArgumentString(child)
      : redactCredentialFields(child)
  }
  return redacted
}

export function sanitizeIncomingHeaders(headers: Headers) {
  const sanitized: Record<string, string> = {}
  for (const [header, value] of headers) {
    sanitized[header] = shouldRedactField(header) ? redactedValue : value
  }
  return sanitized
}

function valueShape(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function ownField(value: Record<string, unknown>, field: string) {
  return Object.prototype.hasOwnProperty.call(value, field)
}

function summarizeContent(value: unknown) {
  if (Array.isArray(value)) {
    return {
      type: "array",
      count: value.length,
      partTypes: value.map((part) => isJsonObject(part) && typeof part.type === "string" ? part.type : valueShape(part)),
    }
  }

  if (isJsonObject(value)) {
    return {
      type: "object",
      fields: Object.keys(value).sort(),
      declaredType: typeof value.type === "string" ? value.type : null,
    }
  }

  return { type: valueShape(value) }
}

function summarizeToolCall(value: unknown, index: number) {
  if (!isJsonObject(value)) {
    return { index, type: valueShape(value) }
  }

  const functionCall = isJsonObject(value.function) ? value.function : null
  return {
    index,
    type: "object",
    toolType: typeof value.type === "string" ? value.type : null,
    hasId: typeof value.id === "string",
    functionName: functionCall && typeof functionCall.name === "string" ? functionCall.name : null,
    hasArguments: Boolean(functionCall && ownField(functionCall, "arguments")),
    argumentType: functionCall ? valueShape(functionCall.arguments) : "undefined",
  }
}

function summarizeMessage(value: unknown, index: number) {
  if (!isJsonObject(value)) {
    return { index, type: valueShape(value) }
  }

  const toolCalls = Array.isArray(value.tool_calls) ? value.tool_calls : []
  return {
    index,
    type: "object",
    role: typeof value.role === "string" ? value.role : null,
    content: summarizeContent(value.content),
    nameType: ownField(value, "name") ? valueShape(value.name) : "absent",
    toolCallCount: toolCalls.length,
    toolCalls: toolCalls.map((toolCall, toolCallIndex) => summarizeToolCall(toolCall, toolCallIndex)),
  }
}

function summarizeTool(value: unknown, index: number) {
  if (!isJsonObject(value)) {
    return { index, type: valueShape(value) }
  }

  const functionDefinition = isJsonObject(value.function) ? value.function : null
  const parameters = functionDefinition && isJsonObject(functionDefinition.parameters)
    ? functionDefinition.parameters
    : null
  const properties = parameters && isJsonObject(parameters.properties) ? parameters.properties : null
  const required = parameters && Array.isArray(parameters.required) ? parameters.required : null
  return {
    index,
    type: "object",
    toolType: typeof value.type === "string" ? value.type : null,
    functionName: functionDefinition && typeof functionDefinition.name === "string" ? functionDefinition.name : null,
    hasDescription: Boolean(functionDefinition && typeof functionDefinition.description === "string"),
    parameterType: parameters && typeof parameters.type === "string" ? parameters.type : null,
    parameterPropertyCount: properties ? Object.keys(properties).length : 0,
    requiredParameterCount: required ? required.length : 0,
  }
}

function summarizePayload(value: unknown) {
  if (!isJsonObject(value)) {
    return { bodyType: valueShape(value) }
  }

  const messages = Array.isArray(value.messages) ? value.messages : []
  const tools = Array.isArray(value.tools) ? value.tools : []
  const responseFormat = isJsonObject(value.response_format) ? value.response_format : null
  return {
    bodyType: "object",
    topLevelFields: Object.keys(value).sort(),
    fieldTypes: Object.fromEntries(Object.entries(value).map(([field, child]) => [field, valueShape(child)])),
    incomingModel: typeof value.model === "string" ? value.model : null,
    stream: typeof value.stream === "boolean" ? value.stream : null,
    messageCount: messages.length,
    messages: messages.map((message, index) => summarizeMessage(message, index)),
    roles: messages.map((message) => isJsonObject(message) && typeof message.role === "string" ? message.role : null),
    tools: {
      count: tools.length,
      items: tools.map((tool, index) => summarizeTool(tool, index)),
    },
    responseFormatType: responseFormat && typeof responseFormat.type === "string" ? responseFormat.type : null,
    settings: {
      temperatureType: valueShape(value.temperature),
      topPType: valueShape(value.top_p),
      maxTokensType: valueShape(value.max_tokens),
      toolChoiceType: valueShape(value.tool_choice),
      parallelToolCallsType: valueShape(value.parallel_tool_calls),
    },
  }
}

export function buildInferencePayloadLog(organizationId: string, payload: unknown): PayloadLog {
  if (organizationId === DEBUG_PAYLOAD_ORGANIZATION_ID) {
    return { mode: "full", payload: redactCredentialFields(payload) }
  }
  return { mode: "summary", payload: summarizePayload(payload) }
}

export function buildUnparsedPayloadLog(reason: string, contentType: string | null): PayloadLog {
  return {
    mode: "summary",
    payload: {
      bodyType: "unparsed",
      reason,
      contentType,
    },
  }
}

function reportAttributes(report: InferenceRequestReport | InferenceHandledErrorReport) {
  return {
    organizationId: report.organizationId,
    orgMembershipId: report.orgMembershipId,
    inferenceKeyId: report.inferenceKeyId,
    openworkRequestId: report.openworkRequestId,
    route: report.route,
    method: report.method,
    incomingModel: report.incomingModel,
    resolvedUpstreamModel: report.resolvedUpstreamModel,
    headers: report.headers,
  }
}

function reportTags(report: InferenceRequestReport | InferenceHandledErrorReport) {
  return {
    organization_id: report.organizationId,
    inference_key_id: report.inferenceKeyId,
    openwork_request_id: report.openworkRequestId,
    route: report.route,
    method: report.method,
  }
}

export const sentryInferenceReporter: InferenceReporter = {
  request(report) {
    Sentry.logger.info("OpenWork chat completions inference request", {
      ...reportAttributes(report),
      payloadMode: report.payloadMode,
      payload: report.payload,
    })
  },
  handledError(report) {
    const attributes = {
      ...reportAttributes(report),
      reason: report.reason,
      status: report.status,
      statusText: report.statusText,
      upstreamUrl: report.upstreamUrl,
      error: report.error,
    }
    Sentry.logger.error("OpenWork inference handled error", attributes)
    if (report.exception === undefined) {
      Sentry.captureMessage(`OpenWork inference handled error: ${report.reason}`, {
        level: "error",
        tags: reportTags(report),
        contexts: { inference: attributes },
      })
      return
    }
    Sentry.captureException(report.exception, {
      level: "error",
      tags: reportTags(report),
      contexts: { inference: attributes },
    })
  },
}
