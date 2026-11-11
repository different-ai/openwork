/** RFC 8628 desktop adapter. Private codes/tokens stay in the app-owned flow and transport. */
export const DESKTOP_DEVICE_CLIENT_ID = "openwork-desktop-device";
export const DEVICE_LOGIN_UNSUPPORTED = "This OpenWork server doesn't support device sign-in yet. Use the sign-in link instead.";
const FAILED = "Device sign-in failed. Try again or use the sign-in link.";
const MAX_LIFETIME_MS = 15 * 60_000;
const SERVER_DEVICE_UNAVAILABLE = "Device sign-in is not available on this server. Use the sign-in link instead.";

type Destination = { baseUrl: string; apiBaseUrl: string };
type Attempt = { activate(): boolean; isCurrent(): boolean; cancel(): void };
export type DeviceLoginStatus = {
  state: "pending" | "approved" | "denied" | "expired" | "unsupported" | "failed" | "signed_in";
  message?: string;
  email?: string;
  org?: { id: string; name: string };
};
export type DeviceLoginStartOptions = { baseUrl?: string; apiBaseUrl?: string; force?: boolean; requestId?: string };
type Dependencies = {
  isSignedIn(): boolean;
  beginEnrollment(): Attempt;
  prepare(options: DeviceLoginStartOptions, signal: AbortSignal): Promise<Destination | null>;
  enroll(input: { token: string; destination: Destination; attempt: Attempt; signal: AbortSignal }): Promise<{ email: string; org: { id: string; name: string } }>;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deviceUnavailable(value: unknown): boolean {
  return record(value) && (value.error === "access_denied" || value.code === "FORBIDDEN")
    && (value.error_description === SERVER_DEVICE_UNAVAILABLE || value.message === SERVER_DEVICE_UNAVAILABLE);
}

export function deviceRetryAfterMs(value: string | null, now: number): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    // Even an overflowing delta-seconds value means wait past this flow's
    // deadline, not retry immediately.
    return Math.min(MAX_LIFETIME_MS, Number(trimmed) * 1000);
  }
  if (!/^(?:[A-Za-z]{3}, |[A-Za-z]+, \d{2}-|[A-Za-z]{3} [A-Za-z]{3} )/.test(trimmed)) return 0;
  const date = Date.parse(/^[A-Za-z]{3} [A-Za-z]{3} /.test(trimmed) ? `${trimmed} GMT` : trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("cancelled")); return; }
    const cancel = () => { clearTimeout(timer); reject(new Error("cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** No error body, request URL, device code, or credential is ever returned to control callers. */
export function createDesktopDeviceLogin(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;
  let status: DeviceLoginStatus = { state: "failed", message: "No device sign-in is pending." };
  let current: { attempt: Attempt; controller: AbortController } | null = null;
  // Public caller correlation only, never sent to Den or used as auth authority.
  // Retain terminal ownership so an older command cannot inspect a later result.
  let ownerRequestId: string | undefined;
  const superseded = (): DeviceLoginStatus => ({ state: "failed", message: "Device sign-in was superseded by a newer sign-in." });
  const isOwner = (requestId?: string) => requestId === undefined || requestId === ownerRequestId;

  function cancel(requestId?: string): DeviceLoginStatus {
    if (!isOwner(requestId)) return superseded();
    if (current) {
      current.attempt.cancel();
      current.controller.abort();
      current = null;
      status = { state: "failed", message: "Device sign-in was cancelled." };
    }
    return { ...status };
  }

  async function start(options: DeviceLoginStartOptions = {}) {
    if (deps.isSignedIn() && !options.force) {
      return { ok: false, error: "Already signed in. Use --force to replace this sign-in." };
    }
    cancel();
    const flow = { attempt: deps.beginEnrollment(), controller: new AbortController() };
    current = flow;
    ownerRequestId = options.requestId;
    status = { state: "pending" };
    const live = () => current === flow && flow.attempt.isCurrent() && !flow.controller.signal.aborted;
    const finish = (state: DeviceLoginStatus["state"], message?: string) => {
      if (current !== flow) return;
      status = { state, ...(message ? { message } : {}) };
      current = null;
      flow.controller.abort();
      flow.attempt.cancel();
    };
    const startDeadline = now() + 10_000;
    async function request(destination: Destination, path: string, body: unknown, deadline: number) {
      const response = await (deps.fetcher ?? fetch)(`${destination.apiBaseUrl.replace(/\/+$/, "")}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), credentials: "omit", redirect: "error",
        signal: AbortSignal.any([flow.controller.signal, AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(10_000, deadline - now()))))]),
      });
      const payload: unknown = await response.json().catch(() => null);
      return { response, payload };
    }
    try {
      const prepared = await deps.prepare(options, AbortSignal.any([flow.controller.signal, AbortSignal.timeout(10_000)]));
      if (!live()) throw new Error("superseded");
      if (!prepared) {
        finish("unsupported", DEVICE_LOGIN_UNSUPPORTED);
        return { state: "unsupported", message: DEVICE_LOGIN_UNSUPPORTED };
      }
      if (!flow.attempt.activate()) throw new Error("superseded");
      const destination = prepared;
      const started = await request(destination, "/api/auth/device/code", { client_id: DESKTOP_DEVICE_CLIENT_ID }, startDeadline);
      if (!live()) throw new Error("superseded");
      const body = started.payload;
      if (started.response.status === 404 || (record(body) && body.error === "invalid_client") || deviceUnavailable(body)) {
        finish("unsupported", DEVICE_LOGIN_UNSUPPORTED);
        return { state: "unsupported", message: DEVICE_LOGIN_UNSUPPORTED };
      }
      if (!started.response.ok || !record(body) || typeof body.device_code !== "string" || !body.device_code || typeof body.user_code !== "string" || !body.user_code) throw new Error("invalid response");
      // Only the public user code may appear in the approval URL. Never echo arbitrary server URLs.
      const verificationUri = `${destination.baseUrl.replace(/\/+$/, "")}/device`;
      const publicAuthorization = {
        userCode: body.user_code,
        verificationUri,
        verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(body.user_code)}`,
        expiresAt: now() + Math.min(MAX_LIFETIME_MS, typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in * 1000 : MAX_LIFETIME_MS),
      };
      const deviceCode = body.device_code;
      let intervalMs = typeof body.interval === "number" && Number.isFinite(body.interval) ? Math.max(1, body.interval) * 1000 : 5000;
      const deadline = publicAuthorization.expiresAt;
      async function poll() {
        let delayMs = intervalMs;
        try {
          while (live() && now() < deadline) {
            await wait(Math.min(delayMs, deadline - now()), flow.controller.signal);
            if (!live()) break;
            if (now() >= deadline) { finish("expired"); return; }
            let polled: Awaited<ReturnType<typeof request>>;
            try {
              polled = await request(destination, "/api/auth/device/token", {
                grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: DESKTOP_DEVICE_CLIENT_ID,
              }, deadline);
            } catch {
              if (!live()) break;
              // RFC 8628: reduce request frequency after connection timeouts.
              intervalMs = Math.min(MAX_LIFETIME_MS, intervalMs * 2);
              delayMs = intervalMs;
              continue;
            }
            if (!live()) break;
            if (now() >= deadline) { finish("expired"); return; }
            const payload = polled.payload;
            const error = record(payload) ? payload.error : null;
            if (error === "invalid_client" || polled.response.status === 404 || deviceUnavailable(payload)) { finish("unsupported", DEVICE_LOGIN_UNSUPPORTED); return; }
            if (error === "access_denied") { finish("denied"); return; }
            if (error === "expired_token") { finish("expired"); return; }
            if (polled.response.ok && record(payload) && typeof payload.access_token === "string" && payload.access_token) {
              status = { state: "approved" };
              const identity = await deps.enroll({ token: payload.access_token, destination, attempt: flow.attempt, signal: AbortSignal.any([flow.controller.signal, AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now())))]) });
              if (!live()) break;
              // Enrollment already committed synchronously; do not undo it on a subsequent cancel.
              status = { state: "signed_in", email: identity.email, org: identity.org };
              current = null;
              flow.controller.abort();
              return;
            }
            if (polled.response.status === 429 || error === "slow_down") {
              intervalMs += 5000;
              delayMs = Math.max(intervalMs, deviceRetryAfterMs(polled.response.headers.get("retry-after"), now()), deviceRetryAfterMs(polled.response.headers.get("x-retry-after"), now()));
              continue;
            }
            if (error === "authorization_pending") {
              delayMs = Math.max(intervalMs, deviceRetryAfterMs(polled.response.headers.get("retry-after"), now()), deviceRetryAfterMs(polled.response.headers.get("x-retry-after"), now()));
              continue;
            }
            finish("failed", FAILED);
            return;
          }
          if (current === flow) finish(live() ? "expired" : "failed", live() ? undefined : "Device sign-in was superseded by a newer sign-in.");
        } catch {
          if (current === flow) finish(now() >= deadline ? "expired" : "failed", now() >= deadline ? undefined : FAILED);
        }
      }
      void poll();
      return publicAuthorization;
    } catch {
      if (current === flow) finish("failed", FAILED);
      return { ok: false, error: FAILED };
    }
  }

  return {
    start,
    status: (requestId?: string): DeviceLoginStatus => {
      if (!isOwner(requestId)) return superseded();
      if (current && !current.attempt.isCurrent()) cancel(requestId);
      return { ...status, ...(status.org ? { org: { ...status.org } } : {}) };
    },
    cancel,
  };
}
