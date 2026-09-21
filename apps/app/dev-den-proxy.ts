interface DevDenProxyOptions {
  target: string;
  changeOrigin: boolean;
  rewrite?: (path: string) => string;
}

export function devDenProxy(env: NodeJS.ProcessEnv): Record<string, DevDenProxyOptions> {
  const target = env.OPENWORK_DEV_HEADLESS_DEN_TARGET?.trim();
  if (!target) return {};
  const selectedApiTarget = env.OPENWORK_DEV_DEN_API_PROXY_TARGET?.trim();
  let apiTarget: string | undefined;
  if (selectedApiTarget) {
    const url = new URL(selectedApiTarget);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("Den API proxy target must be a nonsecret HTTP(S) origin.");
    }
    apiTarget = url.origin;
  }
  let hosted = false;
  try {
    const url = new URL(target);
    hosted = url.origin === "https://app.openworklabs.com"
      && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
  } catch {}
  return {
    "/api/den": {
      target: apiTarget ?? (hosted ? "https://api.openworklabs.com" : target),
      changeOrigin: true,
      ...(apiTarget || hosted ? { rewrite: (path: string) => path.replace(/^\/api\/den(?=\/|\?|$)/, "") || "/" } : {}),
    },
  };
}
