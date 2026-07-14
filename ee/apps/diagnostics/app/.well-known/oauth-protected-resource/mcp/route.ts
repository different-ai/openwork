import { GET as handleProtectedResourceMetadata } from "../route"

export const dynamic = "force-dynamic"

export function GET(request: Request): Promise<Response> {
  return handleProtectedResourceMetadata(request)
}
