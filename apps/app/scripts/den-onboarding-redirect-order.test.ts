import { describe, expect, test } from "bun:test";

import { createOnboardingRedirectScheduler } from "../src/react-app/shell/app-root";

function harness(maxAttempts = 10) {
  let identity = { authToken: "token-a", activeOrgId: "" };
  let navigations = 0;
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();
  const scheduler = createOnboardingRedirectScheduler({
    readIdentity: () => identity,
    navigate: () => {
      navigations += 1;
    },
    schedule: (callback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    clear: (handle) => callbacks.delete(handle),
    maxAttempts,
    delayMs: 1,
  });
  const runNext = () => {
    const entry = callbacks.entries().next().value;
    if (!entry) return false;
    callbacks.delete(entry[0]);
    entry[1]();
    return true;
  };
  return {
    scheduler,
    runNext,
    pending: () => callbacks.size,
    navigations: () => navigations,
    setIdentity: (next: typeof identity) => {
      identity = next;
    },
  };
}

describe("createOnboardingRedirectScheduler", () => {
  test("only the latest successful sign-in can navigate once", () => {
    const test = harness();
    test.scheduler.start("token-a");
    test.scheduler.start("token-b");
    test.setIdentity({ authToken: "token-b", activeOrgId: "org-b" });
    test.runNext();

    expect(test.navigations()).toBe(1);
    expect(test.pending()).toBe(0);
    expect(test.runNext()).toBe(false);
  });

  test("cancels pending navigation on sign-out or unmount", () => {
    const test = harness();
    test.scheduler.start("token-a");
    test.scheduler.cancel();
    test.setIdentity({ authToken: "token-a", activeOrgId: "org-a" });

    expect(test.runNext()).toBe(false);
    expect(test.navigations()).toBe(0);
  });

  test("does not navigate for a different current token", () => {
    const test = harness(2);
    test.scheduler.start("token-a");
    test.setIdentity({ authToken: "token-b", activeOrgId: "org-b" });
    test.runNext();
    test.runNext();

    expect(test.navigations()).toBe(0);
    expect(test.pending()).toBe(0);
  });

  test("stops quietly when the bounded wait expires", () => {
    const test = harness(3);
    test.scheduler.start("token-a");
    while (test.runNext()) {}

    expect(test.navigations()).toBe(0);
    expect(test.pending()).toBe(0);
  });
});
