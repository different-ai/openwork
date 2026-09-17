interface DevOpenworkProxyOptions {
  target: string;
  changeOrigin: boolean;
  ws: boolean;
  rewrite: (path: string) => string;
}

export function devOpenworkProxy(env: NodeJS.ProcessEnv): Record<string, DevOpenworkProxyOptions> {
  if (env.OPENWORK_DEV_MODE !== "1" || !env.OPENWORK_DEV_OPENWORK_PROXY_TARGET) return {};
  const target = new URL(env.OPENWORK_DEV_OPENWORK_PROXY_TARGET);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port
    || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
    throw new Error("Invalid development-only OpenWork proxy configuration.");
  }
  return {
    "/api/openwork": {
      target: target.origin,
      changeOrigin: true,
      ws: true,
      rewrite: (path: string) => path.replace(/^\/api\/openwork(?=\/|\?|$)/, "") || "/",
    },
  };
}
