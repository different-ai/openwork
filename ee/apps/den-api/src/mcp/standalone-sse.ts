export function rejectStandaloneSseResponse() {
  // The MCP SDK treats 405 as a terminal "standalone SSE unsupported" result.
  // A bodyless 204 is unsafe under Bun: fetch exposes it as an empty stream,
  // which SDK 1.29.0 reconnects once per second without exhausting retries.
  return new Response(null, { status: 405, headers: { allow: "POST" } })
}
