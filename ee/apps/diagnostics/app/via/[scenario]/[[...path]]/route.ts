import { proxyConnectDebugRequest } from "../../../../src/connect-debug-proxy"

export const dynamic = "force-dynamic"
export const maxDuration = 60
export const runtime = "nodejs"

type RouteContext = {
  params: Promise<{ path?: string[]; scenario: string }>
}

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const params = await context.params
  return proxyConnectDebugRequest({
    pathSegments: params.path ?? [],
    request,
    scenarioSlug: params.scenario,
  })
}

export { handle as DELETE, handle as GET, handle as HEAD, handle as OPTIONS, handle as PATCH, handle as POST, handle as PUT }
