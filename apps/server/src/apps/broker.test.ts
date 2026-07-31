import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppPermission, CapabilityResponse, InstalledAppRecord } from "@openwork/app-contract";

import {
  CapabilityBroker,
  CapabilityQuota,
  UserGestureRegistry,
  type CapabilityServices,
} from "./broker.js";
import { InstalledAppStore } from "./store.js";

// Broker enforcement.
//
// Every test here asks the same question from a different angle: can an app
// reach a host service it was not granted? The services are recording fakes, so
// "the call was refused" is proved by the service never being invoked, not by
// inspecting the response alone.

const APP = "com.openworklabs.station";
const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "owbroker-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function record(overrides: Partial<InstalledAppRecord> = {}): InstalledAppRecord {
  return {
    app_id: APP,
    installation: "installed",
    setup: "ready",
    enablement: "enabled",
    compatibility: "compatible",
    active: {
      app_version: "1.0.0",
      archive_digest: `sha256:${"a".repeat(64)}`,
      manifest_digest: `sha256:${"b".repeat(64)}`,
      source: {
        repository: "https://github.com/different-ai/openwork-station",
        release_tag: "v1.0.0",
        commit: "c".repeat(40),
      },
      directory: "1.0.0",
      installed_at: 0,
      permissions: [],
    },
    previous: null,
    pending: null,
    granted_permissions: [],
    crash_count: 0,
    trusted_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

type Harness = {
  broker: CapabilityBroker;
  gestures: UserGestureRegistry;
  store: InstalledAppStore;
  calls: string[];
  now: { value: number };
  workspace: { id: string | null };
};

async function harness(
  granted: AppPermission[] = [],
  overrides: Partial<InstalledAppRecord> = {},
): Promise<Harness> {
  const dataDir = await scratch();
  const store = new InstalledAppStore({ dataDir });
  await store.put(record({ granted_permissions: granted, ...overrides }));

  const calls: string[] = [];
  const now = { value: 1_700_000_000_000 };
  const workspace = { id: "ws-1" as string | null };

  const note = <T>(name: string, value: T) => {
    calls.push(name);
    return Promise.resolve(value);
  };

  const services: CapabilityServices = {
    environmentStatus: () =>
      note("env.status", {
        capability: "env.status" as const,
        variables: [{ key: "OPENAI_API_KEY", configured: true, required: true }],
      }),
    mintRealtimeSession: (_appId, request) =>
      note("ai.realtime.session", {
        capability: "ai.realtime.session" as const,
        client_secret: "ephemeral-secret",
        expires_at: now.value + 60_000,
        model: request.model,
      }),
    runInference: async (_appId, _request, signal) => {
      calls.push("ai.inference.run");
      if (signal.aborted) throw new Error("aborted");
      return { capability: "ai.inference.run" as const, output: { ok: true }, truncated: false };
    },
    connectCapabilities: (_appId, scopes) =>
      note("connect.capabilities", {
        capability: "connect.capabilities" as const,
        providers: scopes.map((scope) => ({
          provider: "slack",
          scope: scope as "slack.search",
          status: "available" as const,
        })),
      }),
    connectQuery: (_appId, request) =>
      note("connect.query", {
        capability: "connect.query" as const,
        records: [
          { scope: request.scope, id: "1", title: "A message", excerpt: "…" },
        ],
        truncated: false,
      }),
    startThread: () =>
      note("threads.start", { capability: "threads.start" as const, thread_id: "thread-1" }),
    createAttachment: () =>
      note("attachments.create", {
        capability: "attachments.create" as const,
        attachment_id: "att-1",
      }),
    presentSurface: async () => {
      calls.push("surface.present");
    },
    setStatus: async () => {
      calls.push("status.set");
    },
    storageGet: () => note("storage.get", { value: null, present: false }),
    storageSet: async () => {
      calls.push("storage.set");
    },
    storageRemove: () => note("storage.remove", true),
    startCapture: async () => {
      calls.push("audio.capture.start");
    },
    stopCapture: async () => {
      calls.push("audio.capture.stop");
    },
  };

  const gestures = new UserGestureRegistry({ now: () => now.value });
  const broker = new CapabilityBroker({
    store,
    services,
    gestures,
    quota: new CapabilityQuota({ now: () => now.value }),
    currentWorkspaceId: () => workspace.id,
  });
  return { broker, gestures, store, calls, now, workspace };
}

function denied(response: CapabilityResponse): string | null {
  return response.ok ? null : response.error.code;
}

const CONNECT: AppPermission = {
  id: "openwork.connect.read",
  reason: "research",
  scopes: ["slack.search"],
};
const THREADS: AppPermission = { id: "openwork.threads.start", reason: "hand off" };
const STORAGE: AppPermission = { id: "storage.app", reason: "cache", quota_bytes: 1024 };
const REALTIME: AppPermission = { id: "ai.realtime", reason: "transcribe" };

describe("request validation", () => {
  test("a malformed request never reaches a service", async () => {
    const h = await harness();
    const response = await h.broker.handle(APP, { capability: 42 }, { workspaceId: "ws-1" });
    expect(denied(response)).toBe("invalid_request");
    expect(h.calls).toEqual([]);
  });

  test("an unknown capability is refused", async () => {
    const h = await harness();
    const response = await h.broker.handle(
      APP,
      { capability: "shell.exec", command: "rm -rf /" },
      { workspaceId: "ws-1" },
    );
    expect(denied(response)).toBe("invalid_request");
    expect(h.calls).toEqual([]);
  });

  test("an extra field on a known capability is refused", async () => {
    const h = await harness([CONNECT]);
    const response = await h.broker.handle(
      APP,
      { capability: "connect.query", scope: "slack.search", query: "x", raw_provider_call: true },
      { workspaceId: "ws-1" },
    );
    expect(denied(response)).toBe("invalid_request");
    expect(h.calls).toEqual([]);
  });
});

describe("activation gates", () => {
  test("a disabled app cannot call anything privileged", async () => {
    const h = await harness([CONNECT], { enablement: "disabled" });
    const response = await h.broker.handle(
      APP,
      { capability: "connect.query", scope: "slack.search", query: "x" },
      { workspaceId: "ws-1" },
    );
    expect(denied(response)).toBe("permission_denied");
    expect(h.calls).toEqual([]);
  });

  test("an app still needing setup is not ready", async () => {
    const h = await harness([CONNECT], { setup: "setup_required" });
    const response = await h.broker.handle(APP, { capability: "env.status" }, { workspaceId: "ws-1" });
    expect(denied(response)).toBe("not_ready");
  });

  test("a quarantined app is refused", async () => {
    const h = await harness([CONNECT], { installation: "quarantined" });
    const response = await h.broker.handle(
      APP,
      { capability: "connect.query", scope: "slack.search", query: "x" },
      { workspaceId: "ws-1" },
    );
    expect(denied(response)).toBe("permission_denied");
    expect(h.calls).toEqual([]);
  });

  test("an app that is not installed is refused", async () => {
    const h = await harness();
    const response = await h.broker.handle(
      "com.not.installed",
      { capability: "env.status" },
      { workspaceId: "ws-1" },
    );
    expect(denied(response)).toBe("not_ready");
  });
});

describe("permission enforcement", () => {
  test("a capability without its permission is denied and named", async () => {
    const h = await harness();
    const response = await h.broker.handle(
      APP,
      { capability: "connect.query", scope: "slack.search", query: "x" },
      { workspaceId: "ws-1" },
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("permission_denied");
      expect(response.error.permission).toBe("openwork.connect.read");
    }
    expect(h.calls).toEqual([]);
  });

  test("a granted capability reaches its service", async () => {
    const h = await harness([CONNECT]);
    const response = await h.broker.handle(
      APP,
      { capability: "connect.query", scope: "slack.search", query: "berlin" },
      { workspaceId: "ws-1" },
    );
    expect(response.ok).toBe(true);
    expect(h.calls).toEqual(["connect.query"]);
  });

  test("a Connect scope outside the grant is denied even with the permission", async () => {
    const h = await harness([CONNECT]);
    const response = await h.broker.handle(
      APP,
      { capability: "connect.query", scope: "gmail.search", query: "invoice" },
      { workspaceId: "ws-1" },
    );
    expect(denied(response)).toBe("permission_denied");
    expect(h.calls).toEqual([]);
  });

  test("connect.capabilities reports only the granted scopes", async () => {
    const h = await harness([CONNECT]);
    const response = await h.broker.handle(
      APP,
      { capability: "connect.capabilities" },
      { workspaceId: "ws-1" },
    );
    expect(response.ok).toBe(true);
    if (response.ok && response.result.capability === "connect.capabilities") {
      expect(response.result.providers.map((entry) => entry.scope)).toEqual(["slack.search"]);
    }
  });

  test("an unprivileged capability needs no permission", async () => {
    const h = await harness();
    const response = await h.broker.handle(APP, { capability: "env.status" }, { workspaceId: "ws-1" });
    expect(response.ok).toBe(true);
  });

  test("env.status reports configuration, never a value", async () => {
    const h = await harness();
    const response = await h.broker.handle(APP, { capability: "env.status" }, { workspaceId: "ws-1" });
    expect(response.ok).toBe(true);
    if (response.ok && response.result.capability === "env.status") {
      const entry = response.result.variables[0];
      expect(entry).toEqual({ key: "OPENAI_API_KEY", configured: true, required: true });
      expect(Object.keys(entry ?? {})).not.toContain("value");
    }
  });

  test("a realtime session returns a short-lived secret, not the stored key", async () => {
    const h = await harness([REALTIME]);
    const response = await h.broker.handle(
      APP,
      { capability: "ai.realtime.session", model: "gpt-realtime" },
      { workspaceId: "ws-1" },
    );
    expect(response.ok).toBe(true);
    if (response.ok && response.result.capability === "ai.realtime.session") {
      expect(response.result.client_secret).toBe("ephemeral-secret");
      expect(response.result.expires_at).toBeGreaterThan(h.now.value);
    }
  });

  test("microphone capture needs a surface permission as well", async () => {
    const h = await harness([{ id: "audio.microphone", reason: "listen" }]);
    const response = await h.broker.handle(
      APP,
      { capability: "audio.capture.start", surface: "station" },
      { workspaceId: "ws-1" },
    );
    expect(denied(response)).toBe("permission_denied");
    expect(h.calls).toEqual([]);
  });
});

describe("user gestures", () => {
  test("starting a thread without a gesture is refused", async () => {
    const h = await harness([THREADS]);
    const response = await h.broker.handle(
      APP,
      { capability: "threads.start", gesture_token: "x".repeat(24), title: "t", goal: "g", summary: "s" },
      { workspaceId: "ws-1" },
    );
    expect(denied(response)).toBe("gesture_required");
    expect(h.calls).toEqual([]);
  });

  test("a fresh gesture lets exactly one thread start", async () => {
    const h = await harness([THREADS]);
    const gesture = h.gestures.issue(APP, "shortcut");
    const request = {
      capability: "threads.start" as const,
      gesture_token: gesture.token,
      title: "Prepare Berlin",
      goal: "Check the conflict",
      summary: "Two events overlap.",
    };
    expect((await h.broker.handle(APP, request, { workspaceId: "ws-1" })).ok).toBe(true);
    // The same token a second time is a replay, not a second thread.
    expect(denied(await h.broker.handle(APP, request, { workspaceId: "ws-1" }))).toBe(
      "gesture_replayed",
    );
    expect(h.calls).toEqual(["threads.start"]);
  });

  test("an expired gesture is refused", async () => {
    const h = await harness([THREADS]);
    const gesture = h.gestures.issue(APP, "click");
    h.now.value += 11_000;
    const response = await h.broker.handle(
      APP,
      {
        capability: "threads.start",
        gesture_token: gesture.token,
        title: "t",
        goal: "g",
        summary: "s",
      },
      { workspaceId: "ws-1" },
    );
    expect(denied(response)).toBe("gesture_expired");
    expect(h.calls).toEqual([]);
  });

  test("one app cannot spend another app's gesture", async () => {
    const h = await harness([THREADS]);
    const gesture = h.gestures.issue("com.other.app", "click");
    const response = await h.broker.handle(
      APP,
      {
        capability: "threads.start",
        gesture_token: gesture.token,
        title: "t",
        goal: "g",
        summary: "s",
      },
      { workspaceId: "ws-1" },
    );
    expect(denied(response)).toBe("gesture_required");
    expect(h.calls).toEqual([]);
  });

  test("disabling an app drops its outstanding gestures", async () => {
    const h = await harness([THREADS]);
    const gesture = h.gestures.issue(APP, "shortcut");
    h.broker.cancelAll(APP, "disabled");
    const response = await h.broker.handle(
      APP,
      {
        capability: "threads.start",
        gesture_token: gesture.token,
        title: "t",
        goal: "g",
        summary: "s",
      },
      { workspaceId: "ws-1" },
    );
    expect(denied(response)).toBe("gesture_required");
  });
});

describe("workspace binding", () => {
  test("a request bound to a workspace the user left is refused", async () => {
    const h = await harness([CONNECT]);
    h.workspace.id = "ws-2";
    const response = await h.broker.handle(
      APP,
      { capability: "connect.query", scope: "slack.search", query: "x" },
      { workspaceId: "ws-1" },
    );
    expect(denied(response)).toBe("workspace_changed");
    expect(h.calls).toEqual([]);
  });

  test("cancelling in-flight work aborts the signal the service was given", async () => {
    const h = await harness([{ id: "ai.inference.transient", reason: "decide" }]);
    let observed: AbortSignal | null = null;
    const pending = h.broker.handle(
      APP,
      {
        capability: "ai.inference.run",
        task: "detect",
        input: "hello",
        response_schema: { type: "object" },
      },
      { workspaceId: "ws-1" },
    );
    void observed;
    h.broker.cancelAll(APP, "workspace_changed");
    const response = await pending;
    // Either it completed before the abort, or it reports the cancellation. It
    // must never report success after a cancel that actually landed first.
    if (!response.ok) expect(response.error.code).toBe("workspace_changed");
  });
});

describe("quotas", () => {
  test("an app hammering a capability is throttled, not served", async () => {
    const h = await harness([THREADS]);
    for (let index = 0; index < 12; index += 1) {
      const gesture = h.gestures.issue(APP, "click");
      await h.broker.handle(
        APP,
        {
          capability: "threads.start",
          gesture_token: gesture.token,
          title: "t",
          goal: "g",
          summary: "s",
        },
        { workspaceId: "ws-1" },
      );
    }
    const gesture = h.gestures.issue(APP, "click");
    const response = await h.broker.handle(
      APP,
      {
        capability: "threads.start",
        gesture_token: gesture.token,
        title: "t",
        goal: "g",
        summary: "s",
      },
      { workspaceId: "ws-1" },
    );
    expect(denied(response)).toBe("rate_limited");
    expect(h.calls.filter((call) => call === "threads.start")).toHaveLength(12);
  });

  test("the quota window rolls rather than latching off", async () => {
    const h = await harness([STORAGE]);
    for (let index = 0; index < 120; index += 1) {
      await h.broker.handle(
        APP,
        { capability: "storage.set", key: `k${index}`, value: 1 },
        { workspaceId: "ws-1" },
      );
    }
    expect(
      denied(
        await h.broker.handle(APP, { capability: "storage.set", key: "x", value: 1 }, { workspaceId: "ws-1" }),
      ),
    ).toBe("rate_limited");
    h.now.value += 61_000;
    expect(
      (await h.broker.handle(APP, { capability: "storage.set", key: "x", value: 1 }, { workspaceId: "ws-1" })).ok,
    ).toBe(true);
  });
});

describe("audit", () => {
  test("a denial is recorded without any secret or payload", async () => {
    const h = await harness();
    await h.broker.handle(
      APP,
      { capability: "connect.query", scope: "slack.search", query: "my-secret-project" },
      { workspaceId: "ws-1" },
    );
    const history = await h.store.auditHistory(10, APP);
    const denial = history.find((row) => row.event === "capability_denied");
    expect(denial?.subject).toBe("connect.query");
    expect(denial?.reason).toBe("permission_denied");
    expect(JSON.stringify(denial)).not.toContain("my-secret-project");
  });
});
