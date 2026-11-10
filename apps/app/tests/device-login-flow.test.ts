import { describe, expect, mock, test } from "bun:test";
import { createDesktopDeviceLogin, DESKTOP_DEVICE_CLIENT_ID, DEVICE_LOGIN_UNSUPPORTED, deviceRetryAfterMs } from "../src/app/lib/device-login-flow";

const destination = { baseUrl: "https://den.example.test", apiBaseUrl: "https://api.example.test" };
const authorization = { device_code: "private-device-code", user_code: "ABCD-EFGH", expires_in: 900, interval: 5 };
const identity = { email: "member@example.test", org: { id: "org-b", name: "Second workspace" } };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function harness(input: { enabled?: boolean; signedIn?: boolean; start?: Response | Promise<Response>; responses?: Array<Response | Error>; enroll?: () => Promise<typeof identity> } = {}) {
  let clock = 0;
  let generation = 0;
  const requests: Array<{ url: string; body: unknown }> = [];
  const waits: Array<{ ms: number; wake(): void }> = [];
  const responses = [...(input.responses ?? [])];
  const enroll = mock(input.enroll ?? (async () => identity));
  const prepare = mock(async () => input.enabled === false ? null : destination);
  const flow = createDesktopDeviceLogin({
    isSignedIn: () => input.signedIn === true,
    beginEnrollment() {
      const attempt = ++generation;
      return { activate: () => attempt === generation, isCurrent: () => attempt === generation, cancel: () => { if (attempt === generation) generation++; } };
    },
    prepare,
    enroll,
    now: () => clock,
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      waits.push({ ms, wake() { clock += ms; resolve(); } });
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }),
    fetcher: async (url, init) => {
      requests.push({ url: String(url), body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      if (String(url).endsWith("/device/code")) return input.start ?? Response.json(authorization);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? Response.json({ error: "authorization_pending" }, { status: 400 });
    },
  });
  return {
    flow, requests, waits, enroll, prepare,
    supersede: () => { generation++; },
    async tick() { const wait = waits.shift(); expect(wait).toBeDefined(); wait?.wake(); await settle(); },
  };
}

describe("desktop-owned device sign-in", () => {
  test("flag off fails closed without requesting a device code", async () => {
    const h = harness({ enabled: false });
    expect(await h.flow.start()).toEqual({ state: "unsupported", message: DEVICE_LOGIN_UNSUPPORTED });
    expect(h.requests).toHaveLength(0);
    expect(h.flow.status().state).toBe("unsupported");
  });

  test("old Den does not fall back to another client ID or echo its error", async () => {
    const h = harness({ start: Response.json({ error: "invalid_client", message: "private-device-code" }, { status: 400 }) });
    expect(await h.flow.start()).toEqual({ state: "unsupported", message: DEVICE_LOGIN_UNSUPPORTED });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.body).toEqual({ client_id: DESKTOP_DEVICE_CLIENT_ID });
  });

  test("requires force to replace an existing sign-in", async () => {
    const h = harness({ signedIn: true });
    expect(await h.flow.start()).toHaveProperty("ok", false);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(await h.flow.start({ force: true })).toHaveProperty("userCode", authorization.user_code);
    h.flow.cancel();
  });

  test("only public code and URLs escape; approval enrolls and reports org B", async () => {
    const h = harness({ responses: [Response.json({ access_token: "private-bearer" })] });
    const started = await h.flow.start();
    expect(started).toEqual({ userCode: authorization.user_code, verificationUri: `${destination.baseUrl}/device`, verificationUriComplete: `${destination.baseUrl}/device?user_code=ABCD-EFGH`, expiresAt: 900_000 });
    expect(h.requests).toHaveLength(1);
    await h.tick();
    expect(h.enroll).toHaveBeenCalledTimes(1);
    expect(h.flow.status()).toEqual({ state: "signed_in", ...identity, runner: "unknown" });
    expect(JSON.stringify([started, h.flow.status(), h.flow.cancel()])).not.toMatch(/private-device-code|private-bearer/);
  });

  test("pending, slow_down and both retry headers retain the same private code", async () => {
    const h = harness({ responses: [
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json({ error: "slow_down" }, { status: 400, headers: { "Retry-After": "20" } }),
      Response.json({ error: "rate_limited" }, { status: 429, headers: { "X-Retry-After": "30" } }),
      Response.json({ access_token: "private-bearer" }),
    ] });
    await h.flow.start();
    expect(h.waits[0]?.ms).toBe(5000);
    await h.tick();
    expect(h.waits[0]?.ms).toBe(5000);
    await h.tick();
    expect(h.waits[0]?.ms).toBe(20000);
    await h.tick();
    expect(h.waits[0]?.ms).toBe(30000);
    await h.tick();
    expect(h.flow.status().state).toBe("signed_in");
    expect(h.requests.slice(1).every((request) => JSON.stringify(request.body) === JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: authorization.device_code, client_id: DESKTOP_DEVICE_CLIENT_ID }))).toBe(true);
  });

  test.each(["access_denied", "expired_token", "invalid_client"])("terminal %s discards the pending flow", async (error) => {
    const h = harness({ responses: [Response.json({ error }, { status: 400 })] });
    await h.flow.start();
    await h.tick();
    expect(h.flow.status().state).toBe(error === "access_denied" ? "denied" : error === "expired_token" ? "expired" : "unsupported");
    expect(h.enroll).not.toHaveBeenCalled();
    expect(h.waits).toHaveLength(0);
  });

  test.each([
    { error: "access_denied", error_description: "Device sign-in is not available on this server. Use the sign-in link instead." },
    { code: "FORBIDDEN", message: "Device sign-in is not available on this server. Use the sign-in link instead." },
  ])("the server's fixed disabled error is unsupported, not a user denial (%j)", async (payload) => {
    const h = harness({ responses: [Response.json(payload, { status: 403 })] });
    await h.flow.start();
    await h.tick();
    expect(h.flow.status()).toEqual({ state: "unsupported", message: DEVICE_LOGIN_UNSUPPORTED });
    expect(h.enroll).not.toHaveBeenCalled();
  });

  test("disabled during code issuance returns only the fixed unsupported message", async () => {
    const h = harness({ start: Response.json({ error: "access_denied", error_description: "Device sign-in is not available on this server. Use the sign-in link instead." }, { status: 403 }) });
    expect(await h.flow.start()).toEqual({ state: "unsupported", message: DEVICE_LOGIN_UNSUPPORTED });
    expect(h.requests).toHaveLength(1);
  });

  test("ordinary access_denied descriptions remain user denial and are never echoed", async () => {
    const h = harness({ responses: [Response.json({ error: "access_denied", error_description: "private-device-code" }, { status: 400 })] });
    await h.flow.start();
    await h.tick();
    expect(h.flow.status()).toEqual({ state: "denied" });
  });

  test("network timeouts back off without restarting the authorization", async () => {
    const h = harness({ responses: [new Error("private-device-code"), Response.json({ access_token: "private-bearer" })] });
    await h.flow.start();
    await h.tick();
    expect(h.waits[0]?.ms).toBe(10000);
    await h.tick();
    expect(h.flow.status().state).toBe("signed_in");
    expect(h.requests.filter((request) => request.url.endsWith("/device/code"))).toHaveLength(1);
  });

  test("caps server lifetime at fifteen minutes and never polls at the deadline", async () => {
    const h = harness({ start: Response.json({ ...authorization, expires_in: 3600, interval: 900 }) });
    expect(await h.flow.start()).toHaveProperty("expiresAt", 900000);
    await h.tick();
    expect(h.flow.status().state).toBe("expired");
    expect(h.requests).toHaveLength(1);
  });

  test("cancel before a poll prevents all token requests", async () => {
    const h = harness();
    await h.flow.start();
    h.flow.cancel();
    await h.tick();
    expect(h.requests).toHaveLength(1);
    expect(h.flow.status()).toMatchObject({ state: "failed", message: "Device sign-in was cancelled." });
  });

  test("cancel racing the initial code response does not publish a late code", async () => {
    let resolve = (_value: Response) => {};
    const response = new Promise<Response>((complete) => { resolve = complete; });
    const h = harness({ start: response });
    const started = h.flow.start();
    await settle();
    h.flow.cancel();
    resolve(Response.json(authorization));
    expect(await started).toHaveProperty("ok", false);
    expect(h.flow.status().message).toBe("Device sign-in was cancelled.");
    expect(h.waits).toHaveLength(0);
  });

  test("a handoff supersedes device polling", async () => {
    const h = harness({ responses: [Response.json({ access_token: "private-bearer" })] });
    await h.flow.start();
    h.supersede();
    await h.tick();
    expect(h.enroll).not.toHaveBeenCalled();
    expect(h.flow.status().state).toBe("failed");
  });

  test("cancel racing enrollment cannot publish a late result or its error", async () => {
    let resolve = (_value: typeof identity) => {};
    const pending = new Promise<typeof identity>((complete) => { resolve = complete; });
    const h = harness({ responses: [Response.json({ access_token: "private-bearer" })], enroll: () => pending });
    await h.flow.start();
    await h.tick();
    expect(h.flow.status().state).toBe("approved");
    h.flow.cancel();
    resolve(identity);
    await settle();
    expect(h.flow.status().state).toBe("failed");
    expect(h.flow.status()).not.toHaveProperty("email");
  });

  test("enrollment failures never echo private bearer errors", async () => {
    const h = harness({ responses: [Response.json({ access_token: "private-bearer" })], enroll: async () => { throw new Error("private-bearer"); } });
    await h.flow.start();
    await h.tick();
    expect(h.flow.status().state).toBe("failed");
    expect(JSON.stringify(h.flow.status())).not.toContain("private-bearer");
  });

  test("Retry-After accepts seconds and HTTP dates, rejects numeric junk", () => {
    expect(deviceRetryAfterMs("20", 0)).toBe(20000);
    expect(deviceRetryAfterMs("9".repeat(400), 0)).toBe(15 * 60_000);
    expect(deviceRetryAfterMs("Thu, 01 Jan 1970 00:01:00 GMT", 10000)).toBe(50000);
    expect(deviceRetryAfterMs("-1", 0)).toBe(0);
  });
});
