export function parseEnterpriseMcpClientEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "true") return true
  if (value === "false") return false
  throw new Error("DEN_ENABLE_ENTERPRISE_MCP_CLIENT must be true or false")
}
