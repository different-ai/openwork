import { describe, expect, mock, test } from "bun:test";
import { createDeviceLoginControl } from "../src/app/lib/device-login-control";
import { DEVICE_LOGIN_UNSUPPORTED, type createDesktopDeviceLogin, type DeviceLoginStatus } from "../src/app/lib/device-login-flow";

function harness() {
  let enabled = false;
  let state: DeviceLoginStatus = { state: "failed", message: "No device sign-in is pending." };
  const start = mock(async (_options = {}): Promise<Awaited<ReturnType<ReturnType<typeof createDesktopDeviceLogin>["start"]>>> => {
    state = { state: "pending" };
    return { userCode: "ABCD-EFGH", verificationUri: "https://den.example.test/device", verificationUriComplete: "https://den.example.test/device?user_code=ABCD-EFGH", expiresAt: 900000 };
  });
  const cancel = mock(() => { state = { state: "failed", message: "Cancelled." }; return state; });
  const control = createDeviceLoginControl({
    flow: { start, status: () => state, cancel },
    deploymentEnabled: () => enabled,
    isConfiguredDestination: (options) => !options.baseUrl || options.baseUrl === "https://den.example.test",
  });
  return { control, start, cancel, enable: (value: boolean) => { enabled = value; }, state: (value: DeviceLoginStatus) => { state = value; } };
}

describe("device control deployment UX gate", () => {
  test("initial status and start return unsupported without entering the flow when off", async () => {
    const h = harness();
    const expected = { state: "unsupported", message: DEVICE_LOGIN_UNSUPPORTED };
    expect(h.control.status()).toEqual(expected);
    expect(await h.control.start()).toEqual(expected);
    expect(await h.control.start({ baseUrl: "https://den.example.test", force: true })).toEqual(expected);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  test("turning the deployment on permits retry after historical unsupported", async () => {
    const h = harness();
    expect(await h.control.start()).toHaveProperty("state", "unsupported");
    h.state({ state: "unsupported", message: DEVICE_LOGIN_UNSUPPORTED });
    h.enable(true);
    expect(await h.control.start({ force: true })).toHaveProperty("userCode", "ABCD-EFGH");
    expect(h.start).toHaveBeenCalledWith({ force: true });
    expect(h.control.status().state).toBe("pending");
  });

  test("an explicit different destination discovers its own flag, not the configured server's", async () => {
    const h = harness();
    expect(await h.control.start({ baseUrl: "https://other.example.test" })).toHaveProperty("userCode");
    expect(h.start).toHaveBeenCalledTimes(1);
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

  test("turning off cannot undo a completed enrollment", () => {
    const h = harness();
    h.state({ state: "signed_in", email: "member@example.test", org: { id: "org-b", name: "Second workspace" }, runner: "unknown" });
    expect(h.control.status().state).toBe("signed_in");
    expect(h.cancel).not.toHaveBeenCalled();
  });
});
