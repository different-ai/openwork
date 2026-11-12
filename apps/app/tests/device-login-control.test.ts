import { describe, expect, mock, test } from "bun:test";
import { createDeviceLoginControl, readDeviceLoginRequestId } from "../src/app/lib/device-login-control";
import { DEVICE_LOGIN_UNSUPPORTED, createDesktopDeviceLogin, type DeviceLoginStatus } from "../src/app/lib/device-login-flow";

function harness() {
  let enabled: boolean | undefined = false;
  let updatedAt = 1;
  let admittedAt: number | null = null;
  let state: DeviceLoginStatus = { state: "failed", message: "No device sign-in is pending." };
  const start = mock(async (_options = {}): Promise<Awaited<ReturnType<ReturnType<typeof createDesktopDeviceLogin>["start"]>>> => {
    state = { state: "pending" };
    admittedAt = updatedAt;
    return { userCode: "ABCD-EFGH", verificationUri: "https://den.example.test/device", verificationUriComplete: "https://den.example.test/device?user_code=ABCD-EFGH", expiresAt: 900000 };
  });
  const cancel = mock((_requestId?: string) => { state = { state: "failed", message: "Cancelled." }; return state; });
  const status = mock((_requestId?: string) => state);
  const control = createDeviceLoginControl({
    flow: { start, status, cancel, admittedAt: () => admittedAt },
    deploymentFeature: () => ({ enabled, updatedAt }),
    isConfiguredDestination: (options) => !options.baseUrl || options.baseUrl === "https://den.example.test",
  });
  return { control, start, cancel, status, enable: (value: boolean | undefined) => { enabled = value; updatedAt++; }, state: (value: DeviceLoginStatus) => { state = value; }, admit: (time: number) => { admittedAt = time; } };
}

function preparingFlow() {
  const destination = { baseUrl: "https://den.example.test", apiBaseUrl: "https://den.example.test" };
  let resolvePreparation = (_value: typeof destination | null) => {};
  const preparation = new Promise<typeof destination | null>((resolve) => { resolvePreparation = resolve; });
  let active = true;
  let feature: { enabled: boolean | undefined; updatedAt: number } = { enabled: undefined, updatedAt: 0 };
  const cancel = mock(() => { active = false; });
  const fetcher = mock(async () => Response.json({ device_code: "private-device-code", user_code: "ABCD-EFGH", expires_in: 900, interval: 60 }));
  const flow = createDesktopDeviceLogin({
    isSignedIn: () => false,
    beginEnrollment: () => ({ activate: () => active, isCurrent: () => active, cancel }),
    prepare: () => preparation,
    enroll: async () => { throw new Error("Enrollment is outside this regression"); },
    fetcher,
    now: () => 10,
  });
  const control = createDeviceLoginControl({ flow, deploymentFeature: () => feature, isConfiguredDestination: () => true });
  return { control, flow, cancel, fetcher, off: () => { feature = { enabled: false, updatedAt: 20 }; }, resolvePreparation, destination };
}

describe("device control with live preparation", () => {
  test("an OFF observation during discovery lets its live OFF reply finish unsupported without a code", async () => {
    const h = preparingFlow();
    const started = h.control.start({ requestId: "preparing-off" });
    try {
      expect(h.flow.admittedAt()).toBeNull();
      h.off();
      const duringPreparation = h.control.status("preparing-off");
      h.resolvePreparation(null);
      expect(await started).toEqual({ state: "unsupported", message: DEVICE_LOGIN_UNSUPPORTED });
      expect(duringPreparation.state).toBe("pending");
      // Finishing unsupported cancels the enrollment attempt exactly once;
      // the cached observation must not have cancelled it before live discovery.
      expect(h.cancel).toHaveBeenCalledTimes(1);
      expect(h.control.status("preparing-off").state).toBe("unsupported");
      expect(h.fetcher).not.toHaveBeenCalled();
    } finally {
      h.resolvePreparation(null);
      await started;
      h.flow.cancel();
    }
  });

  test("a fresh OFF after live admission cancels the pending code lease", async () => {
    const h = preparingFlow();
    const started = h.control.start({ requestId: "admitted-off" });
    try {
      h.resolvePreparation(h.destination);
      expect(await started).toHaveProperty("userCode", "ABCD-EFGH");
      expect(h.flow.admittedAt()).toBe(10);
      expect(h.flow.status("admitted-off").state).toBe("pending");
      h.off();
      expect(h.control.status("admitted-off").state).toBe("unsupported");
      expect(h.cancel).toHaveBeenCalledTimes(1);
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      expect(h.flow.status("admitted-off").state).toBe("failed");
    } finally { h.flow.cancel(); }
  });
});

describe("device control deployment observations", () => {
  test("explicit cached OFF reports unsupported at rest but never blocks live start", async () => {
    const h = harness();
    expect(h.control.status()).toEqual({ state: "unsupported", message: DEVICE_LOGIN_UNSUPPORTED });
    expect(await h.control.start()).toHaveProperty("userCode");
    expect(await h.control.start({ baseUrl: "https://den.example.test", force: true })).toHaveProperty("userCode");
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(h.control.status().state).toBe("pending");
    expect(h.cancel).not.toHaveBeenCalled();
  });

  test("turning the deployment on permits retry after historical unsupported", async () => {
    const h = harness();
    h.state({ state: "unsupported", message: DEVICE_LOGIN_UNSUPPORTED });
    h.enable(true);
    expect(await h.control.start({ force: true })).toHaveProperty("userCode", "ABCD-EFGH");
    expect(h.start).toHaveBeenCalledWith({ force: true });
    expect(h.control.status().state).toBe("pending");
  });

  test("an explicit different destination discovers its own flag, not the configured server's", async () => {
    const h = harness();
    expect(await h.control.start({ baseUrl: "https://other.example.test" })).toHaveProperty("userCode");
    h.enable(false);
    expect(h.control.status().state).toBe("pending");
    expect(h.cancel).not.toHaveBeenCalled();
  });

  test("a refreshed off switch stops a pending configured-server flow without a request", async () => {
    const h = harness();
    h.enable(true);
    await h.control.start();
    h.enable(false);
    expect(h.control.status().state).toBe("unsupported");
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  test("OFF observed before a newer live ON admission cannot kill it, but a later OFF can", async () => {
    const h = harness();
    await h.control.start();
    h.enable(false);
    h.admit(2);
    expect(h.control.status().state).toBe("pending");
    h.enable(false);
    expect(h.control.status().state).toBe("unsupported");
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  test.each(["pending", "failed fetch with stale ON", "failed fetch with stale OFF"])("unknown %s cannot block or cancel pending work", async () => {
    const h = harness();
    h.enable(undefined);
    expect(h.control.status().state).toBe("failed");
    expect(await h.control.start()).toHaveProperty("userCode");
    h.enable(undefined);
    expect(h.control.status().state).toBe("pending");
    expect(h.cancel).not.toHaveBeenCalled();
  });

  test("caller IDs pass through start/status/cancel without an unowned follow-up read", async () => {
    const h = harness();
    h.enable(true);
    await h.control.start({ requestId: "request-b" });
    expect(h.start).toHaveBeenCalledWith({ requestId: "request-b" });
    h.control.status("request-a");
    expect(h.status).toHaveBeenLastCalledWith("request-a");
    h.control.cancel("request-a");
    expect(h.cancel).toHaveBeenLastCalledWith("request-a");
    expect(h.status).toHaveBeenLastCalledWith("request-a");
  });

  test("a scoped failure stays failed and cannot trigger an unowned gate cancellation", () => {
    const h = harness();
    h.state({ state: "failed", message: "Device sign-in was superseded by a newer sign-in." });
    expect(h.control.status("request-a")).toEqual({ state: "failed", message: "Device sign-in was superseded by a newer sign-in." });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.status).toHaveBeenCalledWith("request-a");
  });

  test("configured start enters live discovery with its new owner even when the cache is OFF", async () => {
    const h = harness();
    expect(await h.control.start({ requestId: "request-b" })).toHaveProperty("userCode");
    expect(h.start).toHaveBeenCalledWith({ requestId: "request-b" });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  test("optional request IDs preserve exact strings and reject malformed provided values", () => {
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    expect(readDeviceLoginRequestId({ requestId })).toEqual({ ok: true, requestId });
    expect(readDeviceLoginRequestId(undefined)).toEqual({ ok: true });
    expect(readDeviceLoginRequestId({})).toEqual({ ok: true });
    for (const value of ["", " request-a", "request-a ", "a".repeat(129), 123, null]) {
      expect(readDeviceLoginRequestId({ requestId: value })).toHaveProperty("ok", false);
    }
  });

  test("turning off cannot undo a completed enrollment", () => {
    const h = harness();
    h.state({ state: "signed_in", email: "member@example.test", org: { id: "org-b", name: "Second workspace" } });
    expect(h.control.status().state).toBe("signed_in");
    expect(h.cancel).not.toHaveBeenCalled();
  });
});
