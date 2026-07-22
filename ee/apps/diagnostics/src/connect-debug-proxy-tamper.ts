export type McpTamperMode = "bad-protocol" | "missing-tools"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function tamperResult(result: unknown, mode: McpTamperMode): unknown {
  if (!isRecord(result)) return result
  if (mode === "bad-protocol") return { ...result, protocolVersion: "1900-01-01" }
  if (!Array.isArray(result.tools)) return result
  return {
    ...result,
    tools: result.tools.filter((tool) => !isRecord(tool) || tool.name !== "execute_capability"),
  }
}

function tamperValue(value: unknown, mode: McpTamperMode): unknown {
  if (Array.isArray(value)) return value.map((item) => tamperValue(item, mode))
  if (!isRecord(value)) return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    output[key] = key === "result" ? tamperResult(child, mode) : tamperValue(child, mode)
  }
  return output
}

export function tamperJsonRpcText(raw: string, mode: McpTamperMode): string {
  try {
    const parsed: unknown = JSON.parse(raw)
    return JSON.stringify(tamperValue(parsed, mode))
  } catch {
    return raw
  }
}

function tamperSseEvent(event: string, mode: McpTamperMode): string {
  const boundary = /\r?\n\r?\n$/u.exec(event)?.[0] ?? ""
  const content = boundary ? event.slice(0, -boundary.length) : event
  const lines = content.split(/\r?\n/u)
  const dataIndexes: number[] = []
  const data: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (!line.startsWith("data:")) continue
    dataIndexes.push(index)
    data.push(line.slice(5).replace(/^ /u, ""))
  }
  if (dataIndexes.length === 0) return event
  const joined = data.join("\n")
  const transformed = tamperJsonRpcText(joined, mode)
  if (transformed === joined) return event
  const firstIndex = dataIndexes[0]
  const omitted = new Set(dataIndexes.slice(1))
  return `${lines.filter((_line, index) => !omitted.has(index)).map((line, index) => index === firstIndex ? `data: ${transformed}` : line).join("\n")}${boundary}`
}

export function tamperSseText(raw: string, mode: McpTamperMode): string {
  let pending = raw
  let output = ""
  while (pending) {
    const match = /\r?\n\r?\n/u.exec(pending)
    if (!match || match.index === undefined) return output + tamperSseEvent(pending, mode)
    const end = match.index + match[0].length
    output += tamperSseEvent(pending.slice(0, end), mode)
    pending = pending.slice(end)
  }
  return output
}

export function createMcpSseTamperStream(mode: McpTamperMode): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      while (pending) {
        const match = /\r?\n\r?\n/u.exec(pending)
        if (!match || match.index === undefined) break
        const end = match.index + match[0].length
        controller.enqueue(encoder.encode(tamperSseEvent(pending.slice(0, end), mode)))
        pending = pending.slice(end)
      }
    },
    flush(controller) {
      pending += decoder.decode()
      if (pending) controller.enqueue(encoder.encode(tamperSseEvent(pending, mode)))
    },
  })
}

export function requestUsesMcpMethod(body: Uint8Array | undefined, method: "initialize" | "tools/list"): boolean {
  if (!body?.byteLength) return false
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
    if (Array.isArray(parsed)) return parsed.some((item) => isRecord(item) && item.method === method)
    return isRecord(parsed) && parsed.method === method
  } catch {
    return false
  }
}
