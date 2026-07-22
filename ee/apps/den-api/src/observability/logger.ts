import { createJsonStdoutLogger } from "@openwork-ee/utils/observability"
import type { JsonObject, StructuredLogLevel } from "@openwork-ee/utils/observability"
import { observabilityConfig } from "./config.js"
import { getRuntimeState } from "./runtime.js"
import { sanitizeFields, sanitizeText } from "./safe-fields.js"

type LogFields = Readonly<Record<string, unknown>>

export type AppLogger = {
  log: (level: StructuredLogLevel, message: string, fields?: LogFields) => void
  debug: (message: string, fields?: LogFields) => void
  info: (message: string, fields?: LogFields) => void
  warn: (message: string, fields?: LogFields) => void
  error: (message: string, fields?: LogFields) => void
  child: (fields: LogFields) => AppLogger
}

type AppLoggerOptions = {
  serviceName?: string
  fields?: LogFields
  write?: (line: string) => void
  emitProviderLog?: (level: StructuredLogLevel, message: string, fields: JsonObject) => void
  getTraceContext?: () => JsonObject | undefined
}

function defaultWrite(line: string) {
  process.stdout.write(`${line}\n`)
}

function mergeFields(first: LogFields | undefined, second: LogFields | undefined): LogFields | undefined {
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return { ...first, ...second }
}

function mergeJsonFields(first: JsonObject | undefined, second: JsonObject | undefined): JsonObject {
  return {
    ...(first ?? {}),
    ...(second ?? {}),
  }
}

export function createAppLogger(options: AppLoggerOptions = {}): AppLogger {
  const serviceName = options.serviceName ?? observabilityConfig.serviceName
  const baseFields = sanitizeFields(options.fields)
  const stdout = createJsonStdoutLogger({
    serviceName,
    fields: baseFields,
    write: options.write ?? defaultWrite,
  })

  const log = (level: StructuredLogLevel, message: string, fields?: LogFields) => {
    const runtime = getRuntimeState()
    const getTraceContext = options.getTraceContext ?? runtime.getTraceContext
    const emitProviderLog = options.emitProviderLog ?? runtime.emitProviderLog
    const safeFields = mergeJsonFields(mergeJsonFields(baseFields, sanitizeFields(fields)), getTraceContext?.())
    const safeMessage = sanitizeText(message)

    stdout.log(level, safeMessage, safeFields)
    emitProviderLog?.(level, safeMessage, safeFields)
  }

  return {
    log,
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
    child: (fields) => createAppLogger({
      ...options,
      serviceName,
      fields: mergeFields(options.fields, fields),
    }),
  }
}

export const appLogger = createAppLogger()
