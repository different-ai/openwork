import { verifyInternalMcpPrincipalHeader } from "../session.js"
import { workbotOrigin } from "./config.js"
import { workbotConnectRequestSchema, workbotOAuthReturnSchema, type WorkbotOAuthReturn } from "./connect-return-schema.js"

export function workbotConnectReturn(request: Request): WorkbotOAuthReturn | undefined {
  if (!verifyInternalMcpPrincipalHeader(request.headers.get("x-den-internal-mcp-principal"))) return undefined
  const origin = workbotOrigin()
  if (!origin) return undefined
  const url = new URL(request.url)
  const parsed = workbotConnectRequestSchema.safeParse({ returnPath: url.searchParams.get("workbotReturnPath"), requestId: url.searchParams.get("workbotRequestId") })
  return parsed.success ? { ...parsed.data, origin } : undefined
}

export function workbotCallbackReturn(value: WorkbotOAuthReturn | undefined, connectionId: string) {
  if (!value || value.origin !== workbotOrigin() || !workbotOAuthReturnSchema.safeParse(value).success) return undefined
  return { ...value, connectionId }
}
