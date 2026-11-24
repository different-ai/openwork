import { serve } from "@hono/node-server"

export const DEN_HTTP_KEEP_ALIVE_TIMEOUT_MS = 120_000

type ServeOptions = Parameters<typeof serve>[0]
type DenHttpOptions = Pick<ServeOptions, "fetch" | "port" | "hostname">

export function serveDenHttp(options: DenHttpOptions, listeningListener?: Parameters<typeof serve>[1]) {
  return serve({
    ...options,
    serverOptions: { keepAliveTimeout: DEN_HTTP_KEEP_ALIVE_TIMEOUT_MS },
  }, listeningListener)
}
