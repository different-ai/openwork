const EXTERNAL_MCP_CALLBACK_PATH = /^\/v1\/mcp-connections\/[^/]+\/connect\/callback$/

function redactCallbackPath(path: string): string {
  let parsed: URL
  try {
    parsed = new URL(path, "http://den-request-log.invalid")
  } catch {
    return path
  }
  if (!EXTERNAL_MCP_CALLBACK_PATH.test(parsed.pathname)) return path
  return parsed.search
    ? `${parsed.pathname}?oauth_callback=%5BREDACTED%5D`
    : parsed.pathname
}

/** Redacts OAuth callback credentials before Hono writes the request path. */
export function redactDenRequestLogLine(line: string): string {
  const match = /^(<--|-->)\s+(\S+)\s+(\S+)(.*)$/.exec(line)
  if (!match) return line
  const [, direction, method, path, suffix] = match
  return `${direction} ${method} ${redactCallbackPath(path)}${suffix}`
}
