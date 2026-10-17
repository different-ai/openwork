import { expect, test } from "bun:test";
import { createEngineMigrationAnalyticsObserver, type EngineMigrationAnalyticsStatus } from "../src/app/lib/engine-migration-analytics";
import { startEngineMigrationAnalyticsPolling } from "../src/react-app/shell/use-engine-migration-analytics";
import type { AnalyticsProperties } from "../src/app/lib/analytics";

const initial: EngineMigrationAnalyticsStatus = {
  enabled: false, chatRouting: false, running: false,
  mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [],
  migration: { state: "idle", imported: 0, skipped: 0, total: 0 },
};

function fixture(surface: "desktop" | "web" = "web") {
  const events: Array<{ name: string; properties: AnalyticsProperties }> = [];
  let saved: string | null = null;
  let changes = 0;
  const options = { surface, appVersion: "1.2.3", capture: (name: string, properties: AnalyticsProperties) => { events.push({ name, properties }); },
    storage: { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } }, engineChanged: () => { changes++; } };
  return { options, events, changes: () => changes, observe: createEngineMigrationAnalyticsObserver(options) };
}

test("same analytics on both surfaces: pending force origin, counts, failures, no private data", () => {
  for (const surface of ["desktop", "web"] satisfies Array<"desktop" | "web">) {
    const f = fixture(surface);
    const running: EngineMigrationAnalyticsStatus = { ...initial, forceUpgradePending: true, engineOrigin: "manual",
      migration: { state: "running", startedAt: "2026-10-17T00:00:00Z", imported: 0, skipped: 0, total: 4 } };
    f.observe("http://private-endpoint/a", running);
    f.observe("http://private-endpoint/a", running);
    f.observe("http://private-endpoint/a", { ...running, migration: { ...running.migration, state: "completed", imported: 2, skipped: 1,
      notCopied: [{ id: "private-chat", title: "private-chat", reason: "rejected" }], trimmed: [{ id: "private-chat", title: "private-chat" }] } });
    f.observe("http://private-endpoint/a", { ...initial, engineOrigin: "manual", migration: { ...running.migration, state: "error", error: "ENOSPC /private/path" } });
    expect(f.events.map(e => e.name)).toEqual(["migration_started", "migration_completed", "migration_failed"]);
    expect(f.events[1]?.properties).toEqual({ surface, appVersion: "1.2.3", origin: "forced", imported: 2, skipped: 1, notCopied: 1, trimmed: 1 });
    expect(f.events[2]?.properties.error).toBe("insufficient_disk_space");
    expect(JSON.stringify(f.events)).not.toContain("private");
  }
});

test("completed receipt emits without fake start, survives reload, scopes by instance", () => {
  const f = fixture();
  const completed: EngineMigrationAnalyticsStatus = { ...initial, engineOrigin: "manual", migration: { ...initial.migration, state: "completed", startedAt: "receipt" } };
  f.observe("http://one", completed);
  const reloaded = createEngineMigrationAnalyticsObserver(f.options);
  reloaded("http://one/", completed);
  reloaded("http://two", completed);
  expect(f.events.map(e => e.name)).toEqual(["migration_completed", "migration_completed"]);
});

test("fresh and reverted routes emit zero-count receipts and route changes refresh once", () => {
  const f = fixture();
  f.observe("http://one", { ...initial, enabled: true, chatRouting: true, engineOrigin: "fresh", engineChangedAt: 1 });
  const reverted = { ...initial, engineOrigin: "reverted", engineChangedAt: 2 } satisfies EngineMigrationAnalyticsStatus;
  f.observe("http://one", reverted);
  f.observe("http://one", reverted);
  expect(f.events.map(e => e.properties.origin)).toEqual(["fresh", "reverted"]);
  expect(f.events.every(e => e.properties.imported === 0)).toBe(true);
  expect(f.changes()).toBe(1);
});

test("polling is non-overlapping, uses 3-second timers, retries, and cleans up", async () => {
  const callbacks: Array<() => void> = [];
  let reads = 0;
  let observed = 0;
  let cancelled = 0;
  const stop = startEngineMigrationAnalyticsPolling({
    read: async () => { reads++; if (reads === 1) throw new Error("offline"); return { baseUrl: "local", status: initial }; },
    observe: () => { observed++; },
    schedule: (callback, ms) => { expect(ms).toBe(3000); callbacks.push(callback); return () => { cancelled++; }; },
  });
  await Promise.resolve(); await Promise.resolve();
  expect(reads).toBe(1);
  callbacks.shift()?.();
  await Promise.resolve(); await Promise.resolve();
  expect(reads).toBe(2);
  expect(observed).toBe(1);
  stop();
  expect(cancelled).toBe(1);
});
