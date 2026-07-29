import { describe, expect, test } from "bun:test";

import { waitForControlActionRegistration } from "../src/react-app/shell/control/control-provider";

describe("control action registration readiness", () => {
  test("returns an action that is already registered", async () => {
    let pauses = 0;
    const action = await waitForControlActionRegistration(
      () => "session.create_task",
      async () => { pauses += 1; },
    );

    expect(action).toBe("session.create_task");
    expect(pauses).toBe(0);
  });

  test("waits for a route-scoped action to register during startup", async () => {
    let action: string | null = null;
    let pauses = 0;
    const registered = await waitForControlActionRegistration(
      () => action,
      async () => {
        pauses += 1;
        if (pauses === 2) action = "session.create_task";
      },
      3,
    );

    expect(registered).toBe("session.create_task");
    expect(pauses).toBe(2);
  });

  test("still reports actions that never register as unknown", async () => {
    let pauses = 0;
    const action = await waitForControlActionRegistration(
      () => null,
      async () => { pauses += 1; },
      2,
    );

    expect(action).toBeNull();
    expect(pauses).toBe(2);
  });
});
