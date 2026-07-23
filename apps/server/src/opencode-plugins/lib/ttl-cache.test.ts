import { describe, expect, test } from "bun:test";

import { createTtlCache } from "./ttl-cache.js";

function deferred<Value>(): {
  promise: Promise<Value>;
  reject: (reason?: unknown) => void;
  resolve: (value: Value | PromiseLike<Value>) => void;
} {
  let resolve = (_value: Value | PromiseLike<Value>) => {};
  let reject = (_reason?: unknown) => {};
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("TTL cache", () => {
  test("caches the in-flight promise for the TTL", async () => {
    let now = 1_000;
    let loads = 0;
    const pending = deferred<string>();
    const cache = createTtlCache<string, string>(30_000, () => now);
    const load = () => {
      loads += 1;
      return pending.promise;
    };

    const first = cache.get("catalog", load);
    now += 29_999;
    const second = cache.get("catalog", load);

    expect(second).toBe(first);
    expect(loads).toBe(1);
    pending.resolve("ready");
    await expect(first).resolves.toBe("ready");
    await expect(second).resolves.toBe("ready");
  });

  test("reloads at the expiration boundary", async () => {
    let now = 10;
    let loads = 0;
    const cache = createTtlCache<string, number>(100, () => now);
    const load = async () => {
      loads += 1;
      return loads;
    };

    await expect(cache.get("catalog", load)).resolves.toBe(1);
    now = 109;
    await expect(cache.get("catalog", load)).resolves.toBe(1);
    now = 110;
    await expect(cache.get("catalog", load)).resolves.toBe(2);
  });

  test("evicts a rejected promise so the next request retries", async () => {
    let loads = 0;
    const cache = createTtlCache<string, string>(30_000);
    const load = () => {
      loads += 1;
      if (loads === 1) return Promise.reject(new Error("temporary failure"));
      return Promise.resolve("recovered");
    };

    await expect(cache.get("catalog", load)).rejects.toThrow("temporary failure");
    await expect(cache.get("catalog", load)).resolves.toBe("recovered");
    expect(loads).toBe(2);
  });

  test("a stale rejection does not evict a newer entry", async () => {
    let now = 0;
    let loads = 0;
    const stale = deferred<string>();
    const current = deferred<string>();
    const cache = createTtlCache<string, string>(10, () => now);
    const load = () => {
      loads += 1;
      return loads === 1 ? stale.promise : current.promise;
    };

    const first = cache.get("catalog", load);
    now = 10;
    const second = cache.get("catalog", load);
    stale.reject(new Error("stale failure"));
    await expect(first).rejects.toThrow("stale failure");

    expect(cache.get("catalog", load)).toBe(second);
    expect(loads).toBe(2);
    current.resolve("current");
    await expect(second).resolves.toBe("current");
  });

  test("supports explicit key deletion and clearing", async () => {
    let loads = 0;
    const cache = createTtlCache<string, number>(30_000);
    const load = async () => {
      loads += 1;
      return loads;
    };

    await expect(cache.get("one", load)).resolves.toBe(1);
    expect(cache.delete("one")).toBeTrue();
    await expect(cache.get("one", load)).resolves.toBe(2);
    await expect(cache.get("two", load)).resolves.toBe(3);

    cache.clear();
    await expect(cache.get("one", load)).resolves.toBe(4);
    await expect(cache.get("two", load)).resolves.toBe(5);
  });

  test("serves bounded stale data while one background refresh runs", async () => {
    let now = 0;
    let loads = 0;
    const refresh = deferred<string>();
    const cache = createTtlCache<string, string>(10, () => now, { maxStaleMs: 100 });
    const load = () => {
      loads += 1;
      return loads === 1 ? Promise.resolve("first") : refresh.promise;
    };

    await expect(cache.getStaleWhileRevalidate("catalog", load).value).resolves.toBe("first");
    now = 10;
    const stale = cache.getStaleWhileRevalidate("catalog", load);
    const coalesced = cache.getStaleWhileRevalidate("catalog", load);
    expect(stale.stale).toBeTrue();
    expect(coalesced.stale).toBeTrue();
    await expect(stale.value).resolves.toBe("first");
    expect(loads).toBe(2);

    refresh.resolve("second");
    await refresh.promise;
    await Promise.resolve();
    await expect(cache.getStaleWhileRevalidate("catalog", load).value).resolves.toBe("second");
  });

  test("retains last-known stale data when a refresh result is unacceptable", async () => {
    let now = 0;
    let loads = 0;
    const cache = createTtlCache<string, string | null>(10, () => now, {
      maxStaleMs: 100,
      shouldReplaceStale: (value) => value !== null,
    });
    const load = async () => {
      loads += 1;
      return loads === 1 ? "last-known-good" : null;
    };

    await expect(cache.getStaleWhileRevalidate("catalog", load).value).resolves.toBe("last-known-good");
    now = 10;
    await expect(cache.getStaleWhileRevalidate("catalog", load).value).resolves.toBe("last-known-good");
    await Promise.resolve();
    now = 11;
    await expect(cache.getStaleWhileRevalidate("catalog", load).value).resolves.toBe("last-known-good");
    expect(loads).toBe(2);
  });

  test("bounds distinct keys with least-recently-used eviction", async () => {
    let loads = 0;
    const cache = createTtlCache<string, number>(1_000, Date.now, { maxEntries: 2 });
    const load = async () => ++loads;

    await cache.get("one", load);
    await cache.get("two", load);
    await cache.get("one", load);
    await cache.get("three", load);
    await expect(cache.get("two", load)).resolves.toBe(4);
  });
});
