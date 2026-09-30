import { serve } from "@hono/node-server"

// cloudflared pools idle origin connections for 90s by default. The origin
// must outlive that pool, otherwise a POST can race Node's idle socket close
// and fail with ECONNRESET before the request reaches the app. Do not solve
// this by replaying POSTs: MCP tools can have external side effects.
// https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/#keepalivetimeout
export const DEN_HTTP_KEEP_ALIVE_TIMEOUT_MS = 120_000

type ServeOptions = Parameters<typeof serve>[0]
type DenHttpOptions = Pick<ServeOptions, "fetch" | "port" | "hostname">

export function serveDenHttp(options: DenHttpOptions, listeningListener?: Parameters<typeof serve>[1]) {
  return serve({
    ...options,
    // Only the *idle, completed response* lifetime changes. Keep Node's
    // bounded request/header timeouts and active streaming behavior intact.
    serverOptions: { keepAliveTimeout: DEN_HTTP_KEEP_ALIVE_TIMEOUT_MS },
  }, listeningListener)
}
