/**
 * Developer-only: a loopback control plane named explicitly in
 * OPENWORK_DEV_FREE_CONTROL_PLANE counts as hosted while OPENWORK_DEV_MODE=1,
 * so a local Den and Gateway can exercise Auto. Packaged builds never set it.
 */
function devFreeControlPlaneOrigin(environment = process.env) {
  if (environment.OPENWORK_DEV_MODE !== "1") return null;
  try {
    const url = new URL(environment.OPENWORK_DEV_FREE_CONTROL_PLANE?.trim() || "");
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.protocol === "http:" ? url.origin : null;
  } catch { return null; }
}

export function desktopFreeBootstrapEligible(distribution, bootstrap, environment = process.env) {
  if (distribution.flavor !== "public" || bootstrap.requireSignin === true || bootstrap.requireActivation === true) return false;
  try {
    const devOrigin = devFreeControlPlaneOrigin(environment);
    const clean = (url) => !url.username && !url.password && !url.search && !url.hash;
    const hosted = (value) => {
      const url = new URL(value);
      return clean(url) && ["https://app.openworklabs.com", "https://api.openworklabs.com", "https://api.app.openworklabs.com"].includes(url.origin);
    };
    // Developer mode: the named loopback control plane, whose API may live on another loopback port.
    const loopback = (value) => {
      const url = new URL(value);
      return clean(url) && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    };
    if (devOrigin && new URL(bootstrap.baseUrl).origin === devOrigin && clean(new URL(bootstrap.baseUrl))) {
      return !bootstrap.apiBaseUrl || loopback(bootstrap.apiBaseUrl);
    }
    return hosted(bootstrap.baseUrl) && (!bootstrap.apiBaseUrl || hosted(bootstrap.apiBaseUrl));
  } catch { return false; }
}
