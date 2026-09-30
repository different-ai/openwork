import { describe, expect, test } from "bun:test";
import { createEngineRoutingPoller } from "../src/react-app/shell/engine-routing-poller";

function harness() {
  const timers = new Map<number, { run: () => void; delay: number }>();
  let timerId = 0;
  const published: Array<[string, boolean]> = [];
  const errors: unknown[] = [];
  const requests: Array<{ key: string; resolve: (value: boolean) => void; reject: (error: unknown) => void }> = [];
  const poller = createEngineRoutingPoller({
    publish: (key, routing) => published.push([key, routing]),
    onError: (error) => errors.push(error),
    schedule: (run, delay) => {
      const id = ++timerId;
      timers.set(id, { run, delay });
      return () => { timers.delete(id); };
    },
  });
  const source = (key: string) => ({
    key,
    read: () => new Promise<boolean>((resolve, reject) => requests.push({ key, resolve, reject })),
  });
  const tick = () => {
    const next = timers.entries().next().value;
    if (!next) throw new Error("No scheduled poll");
    timers.delete(next[0]);
    next[1].run();
  };
  const delays = () => [...timers.values()].map((timer) => timer.delay);
  return { poller, source, requests, published, errors, timers, delays, tick };
}

describe("engine routing polling", () => {
  test("settings events during a read coalesce into one fresh read, without publishing the stale snapshot", async () => {
    const h = harness();
    h.poller.reconcile([h.source("local")]);
    h.poller.refresh();
    h.poller.refresh();
    expect(h.requests).toHaveLength(1);
    expect(h.timers.size).toBe(0);
    h.requests[0].resolve(false);
    await Promise.resolve();
    expect(h.published).toEqual([]);
    expect(h.requests).toHaveLength(2);
    h.requests[1].resolve(true);
    await Promise.resolve();
    expect(h.published).toEqual([["local", true]]);
    expect(h.delays()).toEqual([15_000]);
    h.poller.dispose();
  });

  test("failures retain routing, back off to a bounded delay, and success resets cadence", async () => {
    const h = harness();
    h.poller.reconcile([h.source("local")]);
    h.requests[0].resolve(true);
    await Promise.resolve();
    for (const delay of [30_000, 60_000, 120_000, 120_000]) {
      h.tick();
      h.requests[h.requests.length - 1].reject(new Error("Request timed out"));
      await Promise.resolve();
      expect(h.delays()).toEqual([delay]);
      expect(h.published).toEqual([["local", true]]);
    }
    expect(h.errors).toHaveLength(4);
    h.tick();
    h.requests[h.requests.length - 1].resolve(true);
    await Promise.resolve();
    expect(h.delays()).toEqual([15_000]);
    h.tick();
    h.requests[h.requests.length - 1].reject(new Error("offline"));
    await Promise.resolve();
    expect(h.delays()).toEqual([30_000]);
    h.poller.refresh();
    expect(h.delays()).toEqual([]);
    h.requests[h.requests.length - 1].resolve(false);
    await Promise.resolve();
    expect(h.published.at(-1)).toEqual(["local", false]);
    expect(h.delays()).toEqual([15_000]);
    h.poller.dispose();
  });

  test("stable scopes do not restart polls; selected endpoint/token changes preserve the local flight", async () => {
    const h = harness();
    h.poller.reconcile([h.source("local"), h.source("remote:old-token"), h.source("local")]);
    h.poller.reconcile([h.source("local"), h.source("remote:old-token")]);
    expect(h.requests).toHaveLength(2);
    h.poller.reconcile([h.source("local"), h.source("remote:new-token")]);
    expect(h.requests.map((request) => request.key)).toEqual(["local", "remote:old-token", "remote:new-token"]);
    h.requests[1].resolve(false);
    h.requests[0].resolve(true);
    h.requests[2].resolve(false);
    await Promise.resolve();
    expect(h.published).toEqual([["local", true], ["remote:new-token", false]]);
    expect(h.delays()).toEqual([15_000, 15_000]);
    h.poller.reconcile([h.source("local"), h.source("remote:new-token")]);
    expect(h.requests).toHaveLength(3);
    expect(h.delays()).toEqual([15_000, 15_000]);
    h.poller.dispose();
    expect(h.timers.size).toBe(0);
  });

  test("disposal drops late failures and queued settings reads; a new lifecycle can recover", async () => {
    const h = harness();
    h.poller.reconcile([h.source("local")]);
    h.poller.refresh();
    h.poller.dispose();
    h.requests[0].reject(new Error("late timeout"));
    await Promise.resolve();
    expect(h.errors).toEqual([]);
    expect(h.published).toEqual([]);
    expect(h.requests).toHaveLength(1);
    expect(h.timers.size).toBe(0);
    h.poller.reconcile([h.source("local")]);
    h.poller.dispose();
    h.requests[1].resolve(true);
    await Promise.resolve();
    expect(h.published).toEqual([]);
    expect(h.timers.size).toBe(0);
  });
});
