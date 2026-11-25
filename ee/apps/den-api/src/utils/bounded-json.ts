export async function boundedJson(response: Response, byteLimit: number): Promise<unknown> {
  if (!response.body) throw new Error("Unreadable response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (Number(response.headers.get("content-length")) > byteLimit) throw new Error("Oversized response")
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > byteLimit) throw new Error("Oversized response")
      chunks.push(chunk.value)
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
}
