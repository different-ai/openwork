import { Buffer } from "node:buffer"
import { EnterpriseMcpToolInputError } from "./errors.js"

export const ENTERPRISE_MCP_TOOL_ARGUMENT_LIMIT_BYTES = 1024 * 1024
export const ENTERPRISE_MCP_TOOL_ARGUMENT_DEPTH_LIMIT = 64

export function assertEnterpriseMcpToolArguments(argumentsValue: Record<string, unknown>): void {
  type Frame = { value: unknown; depth: number; leave?: object; key?: string }
  const active = new WeakSet<object>()
  const stack: Frame[] = [{ value: argumentsValue, depth: 0 }]
  let bytes = 0
  const add = (value: string): void => {
    bytes += Buffer.byteLength(value, "utf8")
    if (bytes > ENTERPRISE_MCP_TOOL_ARGUMENT_LIMIT_BYTES) {
      throw new EnterpriseMcpToolInputError("MCP_TOOL_ARGUMENT_SIZE_LIMIT")
    }
  }

  while (stack.length > 0) {
    const frame = stack.pop()
    if (!frame) break
    if (frame.leave) {
      active.delete(frame.leave)
      continue
    }
    if (frame.depth > ENTERPRISE_MCP_TOOL_ARGUMENT_DEPTH_LIMIT) {
      throw new EnterpriseMcpToolInputError("MCP_TOOL_ARGUMENT_DEPTH_LIMIT")
    }
    if (frame.key !== undefined) add(`${JSON.stringify(frame.key)}:`)
    const current = frame.value
    if (current === null || typeof current === "boolean") {
      add(JSON.stringify(current))
      continue
    }
    if (typeof current === "string") {
      add(JSON.stringify(current))
      continue
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new EnterpriseMcpToolInputError("MCP_TOOL_ARGUMENT_INVALID_JSON")
      add(JSON.stringify(current))
      continue
    }
    if (typeof current !== "object") {
      throw new EnterpriseMcpToolInputError("MCP_TOOL_ARGUMENT_INVALID_JSON")
    }
    const prototype = Object.getPrototypeOf(current)
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw new EnterpriseMcpToolInputError("MCP_TOOL_ARGUMENT_INVALID_JSON")
    }
    if (active.has(current)) throw new EnterpriseMcpToolInputError("MCP_TOOL_ARGUMENT_CYCLE")
    active.add(current)
    stack.push({ value: null, depth: frame.depth, leave: current })
    if (Array.isArray(current)) {
      add(`[${",".repeat(Math.max(0, current.length - 1))}]`)
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current[index], depth: frame.depth + 1 })
      }
      continue
    }
    const entries = Object.entries(current)
    add(`{${",".repeat(Math.max(0, entries.length - 1))}}`)
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, value] = entries[index]!
      stack.push({ value, key, depth: frame.depth + 1 })
    }
  }
}
