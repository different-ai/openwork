// Mirrors MCP_APP_MAX_HTML_BYTES in @openwork/types/mcp-app. That subpath
// exposes TypeScript rather than emitted JavaScript, so the packaged Node
// server keeps this dependency-free bound locally. A focused test checks parity.
// Keep total cache storage bounded separately; a larger App does not grow it.
export const MCP_APP_RESOURCE_MAX_BYTES = 1536 * 1024;
