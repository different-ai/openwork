import { describe, expect, test } from "bun:test";

import { runGlobalEventSubscription } from "../src/react-app/kernel/global-sdk-provider";

describe("global SDK event subscription", () => {
  test("reconnects after an engine generation closes the current stream", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let subscriptions = 0;

    await runGlobalEventSubscription({
      signal: controller.signal,
      subscribe: async function* () {
        subscriptions += 1;
        yield `event-${subscriptions}`;
      },
      onEvent(event) {
        if (typeof event !== "string") throw new Error("expected a string event");
        events.push(event);
        if (events.length === 2) controller.abort();
      },
      waitForRetry: async () => undefined,
    });

    expect(subscriptions).toBe(2);
    expect(events).toEqual(["event-1", "event-2"]);
  });
});
