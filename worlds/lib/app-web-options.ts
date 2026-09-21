export interface AppWebWorldOptions {
  place: "local" | "daytona";
  ref?: string;
  lifetimeMinutes?: number;
}

export function parseAppWebOptions(argv: readonly string[], env: NodeJS.ProcessEnv): AppWebWorldOptions {
  const place = env.OPENWORK_WORLD_PLACE ?? "local";
  if (place !== "local" && place !== "daytona") throw new Error("app-web supports only local or daytona placement.");
  let ref: string | undefined;
  let lifetimeMinutes = 120;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || seen.has(key)) throw new Error("Duplicate app-web option.");
    seen.add(key);
    if (key === "--ref" && value && /^[a-f0-9]{40}$/.test(value)) ref = value;
    else if (key === "--lifetime" && value && /^\d+$/.test(value) && Number(value) >= 10 && Number(value) <= 1430) lifetimeMinutes = Number(value);
    else throw new Error("app-web accepts --ref <full-pushed-sha> and --lifetime <10-1430 minutes> after --.");
  }
  if (place === "daytona" && !ref) throw new Error("Daytona app-web requires -- --ref <full-pushed-sha>.");
  if (place === "local" && ref) throw new Error("Local app-web uses this working tree; --ref is only supported on Daytona.");
  return { place, ref, lifetimeMinutes };
}

export function appWebEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = ["OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY", "OPENWORK_DEV_DEN_PROXY_TARGET", "OPENWORK_DEV_DEN_API_PROXY_TARGET"];
  let selected: string[] = [];
  if (source.OPENWORK_WORLD_SELECTED_ENV_KEYS !== undefined) {
    let keys: unknown;
    try { keys = JSON.parse(source.OPENWORK_WORLD_SELECTED_ENV_KEYS); } catch { throw new Error("Invalid world environment selection marker."); }
    if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === "string" && allowed.includes(key))) {
      throw new Error(`app-web --env accepts only ${allowed.join(", ")}.`);
    }
    selected = keys;
  }
  const env: Record<string, string> = {};
  const enabled = selected.includes("OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY") ? source.OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY : undefined;
  if (enabled !== undefined) {
    if (!/^(0|1|true|false|yes|no|on|off)$/i.test(enabled.trim())) throw new Error("Invalid app-web Den proxy selection.");
    env.OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY = enabled;
    if (/^(1|true|yes|on)$/i.test(enabled.trim())) env.VITE_DISABLE_OPENWORK_MODELS = "0";
  }
  const target = selected.includes("OPENWORK_DEV_DEN_PROXY_TARGET") ? source.OPENWORK_DEV_DEN_PROXY_TARGET : undefined;
  const proxyEnabled = enabled !== undefined && /^(1|true|yes|on)$/i.test(enabled.trim());
  if (proxyEnabled !== (target !== undefined)) throw new Error("app-web requires an enabled proxy and target selected together.");
  if (target !== undefined) {
    let url: URL;
    try { url = new URL(target); } catch { throw new Error("Invalid app-web Den proxy target."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("app-web Den proxy target must be a nonsecret HTTP(S) origin.");
    }
    env.OPENWORK_DEV_DEN_PROXY_TARGET = url.origin;
  }
  // Local Den can expose web and API on separate ports. Keep sign-in on the
  // selected web origin while proxying API requests directly, without a 307.
  const apiTarget = selected.includes("OPENWORK_DEV_DEN_API_PROXY_TARGET") ? source.OPENWORK_DEV_DEN_API_PROXY_TARGET : undefined;
  if (apiTarget !== undefined) {
    if (!proxyEnabled || !target) throw new Error("A Den API proxy target requires the enabled Den web proxy and target together.");
    if (source.OPENWORK_WORLD_PLACE === "daytona") throw new Error("A separate Den API proxy target is supported only for local app-web previews.");
    let url: URL;
    try { url = new URL(apiTarget); } catch { throw new Error("Invalid app-web Den API proxy target."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("app-web Den API proxy target must be a nonsecret HTTP(S) origin.");
    }
    env.OPENWORK_DEV_DEN_API_PROXY_TARGET = url.origin;
  }
  return env;
}
