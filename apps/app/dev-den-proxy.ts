interface DevDenProxyOptions {
  target: string;
  changeOrigin: boolean;
  rewrite?: (path: string) => string;
}

export function devDenProxy(env: NodeJS.ProcessEnv): Record<string, DevDenProxyOptions> {
  const target = env.OPENWORK_DEV_HEADLESS_DEN_TARGET?.trim();
  if (!target) return {};
  let hosted = false;
  try {
    const url = new URL(target);
    hosted = url.origin === "https://app.openworklabs.com"
      && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
  } catch {}
  return {
    "/api/den": {
      target: hosted ? "https://api.openworklabs.com" : target,
      changeOrigin: true,
      ...(hosted ? { rewrite: (path: string) => path.replace(/^\/api\/den(?=\/|\?|$)/, "") || "/" } : {}),
    },
  };
}
