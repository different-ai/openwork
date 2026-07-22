import { describe, expect, test } from "bun:test";
import {
  MAX_OBSERVABILITY_CONTENT_CHARS,
  MAX_OBSERVABILITY_JOURNAL_BYTES,
  type ObservabilityEvent,
} from "@openwork/observability";

import {
  createRendererObservationBridge,
  formatSessionSyncObservation,
  RENDERER_OBSERVABILITY_TRANSPORT_MAX_BYTES,
} from "../src/react-app/shell/observability-bridge";
import {
  applyDefensiveContentPolicy,
  OBSERVABILITY_PREFERENCES_STORAGE_KEY,
  persistObservabilityPreferences,
  readObservabilityPreferences,
  retainNewestObservabilityEvents,
} from "../src/react-app/shell/observability-provider";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("observability preferences", () => {
  test("defaults to metadata and never persists the enabled lifecycle flag", () => {
    const storage = memoryStorage();
    const initial = readObservabilityPreferences(storage);
    expect(initial.content).toBe("metadata");

    persistObservabilityPreferences(storage, {
      ...initial,
      enabled: true,
      content: "full",
    });

    const raw = JSON.parse(storage.getItem(OBSERVABILITY_PREFERENCES_STORAGE_KEY) ?? "{}");
    expect(raw.enabled).toBeUndefined();
    expect(raw.content).toBe("full");
    expect(readObservabilityPreferences(storage).content).toBe("full");
  });

  test("defensively strips content that exceeds the selected policy", () => {
    const event: ObservabilityEvent = {
      id: "event-1",
      sequence: 1,
      timestamp: new Date(0).toISOString(),
      level: "info",
      scope: "event",
      action: "sse.event",
      source: { runtime: "renderer", component: "test" },
      content: { kind: "json", hash: "sha256:test", value: { private: true } },
    };

    expect(applyDefensiveContentPolicy(event, "metadata").content).toEqual({ kind: "json" });
    expect(applyDefensiveContentPolicy(event, "hash").content).toEqual({
      kind: "json",
      hash: "sha256:test",
    });
    expect(applyDefensiveContentPolicy(event, "full").content?.value).toEqual({ private: true });
  });
});

describe("renderer observability retention", () => {
  test("keeps the newest events within the shared retained-byte ceiling", () => {
    const payload = "x".repeat(MAX_OBSERVABILITY_CONTENT_CHARS);
    const events = Array.from({ length: 9 }, (_, index): ObservabilityEvent => ({
      id: `event-${index + 1}`,
      sequence: index + 1,
      timestamp: new Date(index).toISOString(),
      level: "info",
      scope: "event",
      action: "sse.event",
      source: { runtime: "renderer", component: "test" },
      content: { kind: "text", value: payload },
    }));

    const retained = retainNewestObservabilityEvents(events, { maxEvents: 100 });

    expect(retained.retainedBytes).toBeLessThanOrEqual(MAX_OBSERVABILITY_JOURNAL_BYTES);
    expect(retained.evictedCount).toBeGreaterThan(0);
    expect(retained.events[0]?.sequence).toBe(retained.evictedCount + 1);
    expect(retained.events.at(-1)?.id).toBe("event-9");
  });

  test("reports count-limit evictions while retaining the newest sequence", () => {
    const events = Array.from({ length: 4 }, (_, index): ObservabilityEvent => ({
      id: `event-${index + 1}`,
      sequence: index + 1,
      timestamp: new Date(index).toISOString(),
      level: "info",
      scope: "lifecycle",
      action: "test.event",
      source: { runtime: "renderer", component: "test" },
    }));

    const retained = retainNewestObservabilityEvents(events, {
      maxEvents: 2,
      maxBytes: MAX_OBSERVABILITY_JOURNAL_BYTES,
    });

    expect(retained.events.map((event) => event.sequence)).toEqual([3, 4]);
    expect(retained.evictedCount).toBe(2);
  });
});

describe("renderer observability bridge", () => {
  test("batches bounded events and redacts metadata before transport", async () => {
    const batches: unknown[][] = [];
    const bridge = createRendererObservationBridge({ maxPending: 2, flushDelayMs: 10_000 });
    bridge.configure({
      enabled: true,
      transport: (events) => { batches.push(events); },
    });

    for (const index of [1, 2, 3]) {
      bridge.record({
        level: "info",
        scope: "renderer",
        action: `test.${index}`,
        source: { runtime: "renderer", component: "test" },
        data: { token: "secret", index },
      });
    }
    expect(bridge.pendingCount()).toBe(2);
    expect(bridge.droppedCount()).toBe(1);
    await bridge.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect((batches[0]?.[0] as { data: { token: string } }).data.token).toBe("[REDACTED]");
  });

  test("keeps raw SSE payload exclusively inside policy-controlled content", () => {
    const raw = {
      directory: "/workspace",
      payload: {
        type: "mcp.tools.changed",
        properties: { server: "docs", privateText: "secret" },
      },
    };
    const event = formatSessionSyncObservation({
      phase: "event",
      workspaceId: "workspace-1",
      raw,
    });

    expect(event.scope).toBe("mcp");
    expect(event.action).toBe("mcp.event");
    expect(event.data).toEqual({
      operation: "opencode-event-stream",
      workspaceId: "workspace-1",
      directory: "/workspace",
      type: "mcp.tools.changed",
    });
    expect(JSON.stringify(event.data)).not.toContain("privateText");
    expect(event.content?.value).toEqual(raw);
    expect(event.content?.hash).toBeUndefined();
  });

  test("promotes tool state and failures into the tool scope", () => {
    const event = formatSessionSyncObservation({
      phase: "event",
      workspaceId: "workspace-1",
      raw: {
        payload: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool",
              tool: "docs_search",
              callID: "call-1",
              state: { status: "error", error: "private failure" },
            },
          },
        },
      },
    });
    expect(event).toMatchObject({
      scope: "tool",
      level: "error",
      action: "tool.state.changed",
      data: {
        toolName: "docs_search",
        callId: "call-1",
        status: "error",
      },
    });
    expect(JSON.stringify(event.data)).not.toContain("private failure");
  });

  test("never sends raw payloads in metadata or hash mode", async () => {
    const raw = {
      payload: {
        type: "session.updated",
        properties: { rawSentinel: "must-not-cross-the-wire" },
      },
    };
    const observation = formatSessionSyncObservation({
      phase: "event",
      workspaceId: "workspace-1",
      raw,
    });

    const serializedByMode = new Map<string, string>();
    for (const content of ["metadata", "hash", "full"] as const) {
      const bridge = createRendererObservationBridge({ flushDelayMs: 10_000 });
      bridge.configure({
        enabled: true,
        content,
        transport: (events) => {
          serializedByMode.set(content, JSON.stringify(events));
        },
      });
      bridge.record(observation);
      await bridge.flush();
    }

    expect(serializedByMode.get("metadata")).not.toContain("must-not-cross-the-wire");
    expect(serializedByMode.get("metadata")).not.toContain("fnv1a32:");
    expect(serializedByMode.get("hash")).not.toContain("must-not-cross-the-wire");
    expect(serializedByMode.get("hash")).toContain("fnv1a32:");
    expect(serializedByMode.get("full")).toContain("must-not-cross-the-wire");
  });

  test("does not traverse content values before full mode", async () => {
    let reads = 0;
    const event = {
      level: "info" as const,
      scope: "event" as const,
      action: "test.getter",
      source: { runtime: "renderer" as const, component: "test" },
      content: {
        kind: "test",
        hash: "sha256:test",
        get value() {
          reads += 1;
          return "raw";
        },
      },
    };
    for (const content of ["metadata", "hash"] as const) {
      const bridge = createRendererObservationBridge({ flushDelayMs: 10_000 });
      bridge.configure({ enabled: true, content, transport: () => {} });
      bridge.record(event);
      await bridge.flush();
    }
    expect(reads).toBe(0);
  });

  test("does not construct observations while disabled and gates scopes before content work", () => {
    const bridge = createRendererObservationBridge({ flushDelayMs: 10_000 });
    let constructions = 0;
    bridge.record(() => {
      constructions += 1;
      return {
        level: "info",
        scope: "event",
        action: "should.not.run",
        source: { runtime: "renderer", component: "test" },
      };
    });
    expect(constructions).toBe(0);

    bridge.configure({
      enabled: true,
      scopes: [],
      transport: () => {},
      content: "full",
    });
    bridge.record(() => {
      constructions += 1;
      return {
        level: "info",
        scope: "event",
        action: "empty.scope.filter",
        source: { runtime: "renderer", component: "test" },
      };
    });
    expect(constructions).toBe(0);

    let reads = 0;
    bridge.configure({
      enabled: true,
      scopes: ["mcp"],
      transport: () => {},
      content: "full",
    });
    bridge.record({
      level: "info",
      scope: "event",
      action: "filtered",
      source: { runtime: "renderer", component: "test" },
      content: {
        get value() {
          reads += 1;
          return "raw";
        },
      },
    });
    expect(reads).toBe(0);
  });

  test("partitions transport batches below the server request ceiling", async () => {
    const event = (index: number) => ({
      level: "info" as const,
      scope: "event" as const,
      action: `batch.${index}`,
      source: { runtime: "renderer" as const, component: "test" },
      data: { payload: "x".repeat(300) },
    });
    const singleEventBytes = new TextEncoder().encode(JSON.stringify({ events: [event(1)] })).byteLength;
    const maxTransportBytes = singleEventBytes + 8;
    const batches: unknown[][] = [];
    const bridge = createRendererObservationBridge({
      flushDelayMs: 10_000,
      maxTransportBytes,
    });
    bridge.configure({
      enabled: true,
      transport: (events) => { batches.push(events); },
    });
    bridge.record(event(1));
    bridge.record(event(2));
    bridge.record(event(3));
    await bridge.flush();

    expect(RENDERER_OBSERVABILITY_TRANSPORT_MAX_BYTES).toBeLessThan(4 * 1024 * 1024);
    expect(batches).toHaveLength(3);
    for (const batch of batches) {
      expect(new TextEncoder().encode(JSON.stringify({ events: batch })).byteLength)
        .toBeLessThanOrEqual(maxTransportBytes);
    }
    expect(bridge.droppedCount()).toBe(0);
  });

  test("counts an individually oversized event as dropped and continues valid batches", async () => {
    const batches: unknown[][] = [];
    const dropped: number[] = [];
    const bridge = createRendererObservationBridge({
      flushDelayMs: 10_000,
      maxTransportBytes: 512,
    });
    bridge.configure({
      enabled: true,
      transport: (events) => { batches.push(events); },
      onDropped: (count) => { dropped.push(count); },
    });
    bridge.record({
      level: "info",
      scope: "event",
      action: "too-large",
      source: { runtime: "renderer", component: "test" },
      data: { payload: "x".repeat(2_000) },
    });
    bridge.record({
      level: "info",
      scope: "event",
      action: "small",
      source: { runtime: "renderer", component: "test" },
    });
    await bridge.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect((batches[0]?.[0] as { action: string }).action).toBe("small");
    expect(bridge.droppedCount()).toBe(1);
    expect(dropped.at(-1)).toBe(1);
  });

  test("marks oversized full renderer content incomplete", async () => {
    let sent = "";
    const bridge = createRendererObservationBridge({ flushDelayMs: 10_000 });
    bridge.configure({
      enabled: true,
      content: "full",
      transport: (events) => { sent = JSON.stringify(events); },
    });
    bridge.record({
      level: "info",
      scope: "event",
      action: "large",
      source: { runtime: "renderer", component: "test" },
      content: {
        kind: "text",
        value: "x".repeat(MAX_OBSERVABILITY_CONTENT_CHARS + 1),
      },
    });
    await bridge.flush();
    expect(sent).toContain('"complete":false');
    expect(sent).toContain('"truncated":true');
    expect(sent).toContain('"capturedHash":"fnv1a32:');
  });
});
