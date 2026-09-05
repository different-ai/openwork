import { describe, expect, test } from "bun:test";

import { initialServerState, serverReducer } from "../src/react-app/kernel/server-provider-state";

describe("server provider state", () => {
  test("preserves state identity for repeated polling results", () => {
    const ready = serverReducer(initialServerState, {
      type: "ready",
      list: ["http://127.0.0.1:4096/opencode"],
      active: "http://127.0.0.1:4096/opencode",
    });
    const healthy = serverReducer(ready, { type: "healthy", healthy: true });

    expect(serverReducer(healthy, { type: "healthy", healthy: true })).toBe(healthy);
    expect(serverReducer(healthy, {
      type: "ready",
      list: ["http://127.0.0.1:4096/opencode"],
      active: "http://127.0.0.1:4096/opencode",
    })).toBe(healthy);
    expect(serverReducer(healthy, {
      type: "add",
      url: "http://127.0.0.1:4096/opencode",
    })).toBe(healthy);
    expect(serverReducer(healthy, {
      type: "remove",
      url: "http://127.0.0.1:9999/opencode",
    })).toBe(healthy);
  });

  test("publishes meaningful health and active-server changes", () => {
    const healthy = serverReducer(initialServerState, { type: "healthy", healthy: true });
    const active = serverReducer(healthy, {
      type: "active",
      active: "http://127.0.0.1:4096/opencode",
    });

    expect(healthy).not.toBe(initialServerState);
    expect(active).not.toBe(healthy);
    expect(active.healthy).toBe(true);
    expect(active.active).toBe("http://127.0.0.1:4096/opencode");
  });
});
