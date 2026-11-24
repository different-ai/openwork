import { installClock } from "./clock.mjs";

const origin = process.env.DEVICE_LOGIN_TEST_ORIGIN;
if (!origin || new URL(origin).hostname !== "127.0.0.1") {
  throw new Error("The device login test requires a loopback origin.");
}
const virtual = process.env.DEVICE_LOGIN_TEST_CLOCK === "virtual";
const clock = virtual ? installClock(Number(process.env.DEVICE_LOGIN_TEST_EPOCH)) : null;
const nativeTimeout = globalThis.setTimeout;
if (clock) {
  globalThis.setTimeout = (callback, delay, ...args) => {
    // Only accelerate the shipped CLI's sleep. Keep all network timers real.
    const stack = new Error().stack ?? "";
    if (stack.includes("at sleep (") && stack.includes("openwork.mjs")) {
      clock.set(clock.now() + Number(delay));
      process.send?.({ type: "device-login-clock", now: clock.now() });
      return nativeTimeout(callback, 0, ...args);
    }
    return nativeTimeout(callback, delay, ...args);
  };
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== origin) throw new Error("The device login test blocked a non-local request.");
  const headers = new Headers(init?.headers);
  headers.set("x-forwarded-for", "192.0.2.10");
  headers.set("x-device-login-test-source", "cli");
  if (clock) headers.set("x-device-login-test-time", String(clock.now()));
  return nativeFetch(input, { ...init, headers, redirect: "error" });
};
