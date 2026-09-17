export function headlessBrowserEnvironment(input: {
  browserHostSuffix?: string;
  openworkUrl: string;
}): Record<string, string> {
  if (input.browserHostSuffix === undefined) return {};
  if (!/^\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(input.browserHostSuffix)) {
    throw new Error("Invalid headless browser host suffix.");
  }
  const target = new URL(input.openworkUrl);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port) {
    throw new Error("Headless browser proxy must target the loopback runtime.");
  }
  return {
    OPENWORK_DEV_BROWSER_HOST_SUFFIX: input.browserHostSuffix,
    OPENWORK_DEV_OPENWORK_PROXY_TARGET: target.origin,
    VITE_OPENWORK_URL: "/api/openwork",
    VITE_OPENWORK_PORT: "443",
    VITE_OPENWORK_FORCE_MANUAL_AUTH: "1",
  };
}
