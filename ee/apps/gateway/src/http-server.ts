import { serve } from "@hono/node-server"

// cloudflared pools idle origin connections for 90s by default. The origin
// must outlive that pool, otherwise a POST can race Node's idle socket close
// (5s by default) and fail with ECONNRESET before the request reaches the app.
// Inference requests are not idempotent, so never solve this by replaying them.
// https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/#keepalivetimeout
export const GATEWAY_HTTP_KEEP_ALIVE_TIMEOUT_MS = 120_000

type ServeOptions = Parameters<typeof serve>[0]
type GatewayHttpOptions = Pick<ServeOptions, "fetch" | "port" | "hostname">

export function serveGatewayHttp(options: GatewayHttpOptions, listeningListener?: Parameters<typeof serve>[1]) {
  return serve({
    ...options,
    // Only the *idle, completed response* lifetime changes. Keep Node's
    // bounded request/header timeouts and active streaming behavior intact.
    serverOptions: { keepAliveTimeout: GATEWAY_HTTP_KEEP_ALIVE_TIMEOUT_MS },
  }, listeningListener)
}
