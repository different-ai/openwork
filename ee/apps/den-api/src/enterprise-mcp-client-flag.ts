export function parseEnterpriseMcpClientEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false
  if (value === "true") return true
  throw new Error("DEN_ENABLE_ENTERPRISE_MCP_CLIENT must be true or false")
}
