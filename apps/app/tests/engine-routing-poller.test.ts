import { describe, expect, test } from "bun:test";

import { createEngineRoutingPoller } from "../src/react-app/shell/engine-routing-poller";

function harness(results: Array<boolean | Error>) {
  const delays: number[] = [];
  const published: boolean[] = [];
  let next: (() => void) | undefined;
  const poller = createEngineRoutingPoller({
    publish: (_key, routing) => published.push(routing),
    onError: () => {},
    schedule: (run, delayMs) => {
      delays.push(delayMs);
      next = run;
      return () => { next = undefined; };
    },
  });
  let reads = 0;
  poller.reconcile([{ key: "server", read: async () => {
    const result = results[Math.min(reads, results.length - 1)];
    reads += 1;
    if (result instanceof Error) throw result;
    return result;
  } }]);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    delays,
    published,
    async tick() {
      await settle();
      const run = next;
      next = undefined;
      run?.();
      await settle();
    },
    settle,
    dispose: () => poller.dispose(),
  };
}

describe("engine routing poller", () => {
  test("retries quickly until the first answer instead of waiting 30s", async () => {
    const poll = harness([new Error("down"), new Error("down"), true]);
    await poll.settle();
    await poll.tick();
    await poll.tick();
    expect(poll.delays).toEqual([250, 500, 15_000]);
    expect(poll.published).toEqual([true]);
    poll.dispose();
  });

  test("falls back to the normal backoff when the server stays unreachable", async () => {
    const poll = harness([new Error("down")]);
    await poll.settle();
    for (let index = 0; index < 9; index += 1) await poll.tick();
    expect(poll.delays).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000, 2_000, 2_000, 30_000, 60_000]);
    expect(poll.published).toEqual([]);
    poll.dispose();
  });

  test("backs off normally after a failure once routing is known", async () => {
    const poll = harness([false, new Error("blip"), new Error("blip")]);
    await poll.settle();
    await poll.tick();
    await poll.tick();
    expect(poll.delays).toEqual([15_000, 30_000, 60_000]);
    expect(poll.published).toEqual([false]);
    poll.dispose();
  });
});
