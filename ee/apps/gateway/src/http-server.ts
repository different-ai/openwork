import { serve } from "@hono/node-server"

export const GATEWAY_HTTP_KEEP_ALIVE_TIMEOUT_MS = 120_000

type ServeOptions = Parameters<typeof serve>[0]
type GatewayHttpOptions = Pick<ServeOptions, "fetch" | "port" | "hostname">

export function serveGatewayHttp(options: GatewayHttpOptions, listeningListener?: Parameters<typeof serve>[1]) {
  return serve({
    ...options,
    serverOptions: { keepAliveTimeout: GATEWAY_HTTP_KEEP_ALIVE_TIMEOUT_MS },
  }, listeningListener)
}
