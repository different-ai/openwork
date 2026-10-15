// The server approves only the gateway origin and returns to /signin. Keep the
// requested app route in this tab, never in a caller-supplied return URL.
const ATTEMPT_KEY = "openwork.webSignin.attempt";
const RETURN_KEY = "openwork.webSignin.return";

export function webSigninTarget(authUrl: string, currentUrl: string): string | null {
  try {
    const target = new URL(authUrl);
    const current = new URL(currentUrl);
    if (target.protocol !== "https:" && target.protocol !== "http:") return null;
    if (target.username || target.password || target.origin === current.origin) return null;
    if (target.searchParams.get("webAuth") !== "1" || target.searchParams.has("desktopAuth")) return null;
    if (target.searchParams.get("webAuthReturn") !== current.origin) return null;
    return target.toString();
  } catch {
    return null;
  }
}

export function safeWebSigninReturn(path: string, origin: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin || /^\/(signin|onboarding|welcome)(\/|$)/i.test(url.pathname)) return null;
    for (const key of ["grant", "error", "token", "code", "denBaseUrl", "apiBaseUrl", "webAuthReturn"]) {
      url.searchParams.delete(key);
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function beginWebSigninRedirect(storage: Storage, target: string, returnPath: string, origin: string): boolean {
  try {
    // One automatic attempt per configured Den per tab. Never expire this on a
    // timer: a slow/failed callback or a reload must not restart the round trip.
    const denOrigin = new URL(target).origin;
    if (storage.getItem(ATTEMPT_KEY) === denOrigin) return false;
    const path = safeWebSigninReturn(returnPath, origin);
    if (path) storage.setItem(RETURN_KEY, path);
    else storage.removeItem(RETURN_KEY);
    storage.setItem(ATTEMPT_KEY, denOrigin);
    return true;
  } catch {
    // Blocked session storage cannot provide loop protection. Keep the manual
    // sign-in gate rather than navigating automatically without that guard.
    return false;
  }
}

export function hasWebSigninRedirect(storage: Storage, denBaseUrl: string): boolean {
  try {
    return storage.getItem(ATTEMPT_KEY) === new URL(denBaseUrl).origin;
  } catch {
    return false;
  }
}

export function finishWebSigninRedirect(storage: Storage, origin: string): string | null {
  try {
    const path = storage.getItem(RETURN_KEY);
    storage.removeItem(RETURN_KEY);
    storage.removeItem(ATTEMPT_KEY);
    return path ? safeWebSigninReturn(path, origin) : null;
  } catch {
    return null;
  }
}
