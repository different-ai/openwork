import { expect, test } from "bun:test";
import { createRunQualityTracker } from "@openwork/product-analytics";
import { analyticsVersion, createUpdateAnalytics } from "@openwork/product-analytics";
import { analyticsLaunchProperties, analyticsRuntimeProperties, recordAnalyticsLaunch } from "@openwork/product-analytics";

function storageFixture() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test("launch count and first launch persist, with whole-day age and clock rollback protection", () => {
  const storage = storageFixture();
  const firstTime = Date.UTC(2026, 0, 1);
  const first = recordAnalyticsLaunch(storage, firstTime);
  expect(analyticsLaunchProperties(first, firstTime)).toEqual({ run_number: 1, install_age_days: 0 });
  const later = firstTime + 2.75 * 86_400_000;
  const second = recordAnalyticsLaunch(storage, later);
  expect(analyticsLaunchProperties(second, later)).toEqual({ run_number: 2, install_age_days: 2 });
  expect(recordAnalyticsLaunch(storage, later).runNumber).toBe(3);
  expect(analyticsLaunchProperties(second, firstTime - 1).install_age_days).toBe(0);
});

test("corrupt or inaccessible storage cannot break analytics", () => {
  for (const raw of ["bad json", "null", '{"runNumber":-2,"firstLaunchAt":"secret"}', '{"runNumber":1.5,"firstLaunchAt":9999999999999}']) {
    const storage = { getItem: () => raw, setItem: () => {} };
    expect(analyticsLaunchProperties(recordAnalyticsLaunch(storage, 1000), 1000)).toEqual({ run_number: 1, install_age_days: 0 });
  }
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  expect(analyticsLaunchProperties(recordAnalyticsLaunch(blocked, 1000), 1000)).toEqual({ run_number: 1, install_age_days: 0 });
});

test("official releases require both the release marker and packaged Electron; architecture comes from the bridge", () => {
  const meta = { platform: "darwin", arch: "arm64", isPackaged: true };
  expect(analyticsRuntimeProperties(meta, true, "MacIntel")).toEqual({ official_build: true, os: "mac", arch: "arm64" });
  expect(analyticsRuntimeProperties(meta, false, "MacIntel").official_build).toBe(false);
  expect(analyticsRuntimeProperties({ ...meta, isPackaged: false }, true, "MacIntel").official_build).toBe(false);
  expect(analyticsRuntimeProperties(undefined, true, "MacIntel")).toEqual({ official_build: false, os: "mac", arch: "other" });
  expect(analyticsRuntimeProperties({ platform: "windows", arch: "x64" }, false, "").os).toBe("windows");
  expect(analyticsRuntimeProperties({ platform: "linux" }, false, "").os).toBe("linux");
  expect(analyticsRuntimeProperties(undefined, false, "private text").os).toBe("other");
});

test("run quality measures first output once, counts unique calls and prompts, and persists only success", () => {
  const storage = storageFixture();
  let time = 100;
  const runs = createRunQualityTracker(() => storage, () => time);
  expect(runs.isFirstRun()).toBe(true);
  runs.start("run");
  time = 125;
  expect(runs.output("run")).toBe(true);
  time = 150;
  expect(runs.output("run")).toBe(false);
  runs.tool("run", "call");
  runs.tool("run", "call");
  runs.permission("run", "permission");
  runs.permission("run", "permission");
  expect(runs.finish("run")).toEqual({ is_first_run_on_install: true, duration_ms: 50, time_to_first_output_ms: 25, tool_call_count: 1, permission_prompt_count: 1 });
  expect(runs.isFirstRun()).toBe(true);
  runs.start("retry");
  expect(runs.finish("retry", true).is_first_run_on_install).toBe(true);
  expect(runs.isFirstRun()).toBe(false);
  expect(createRunQualityTracker(() => storage).isFirstRun()).toBe(false);
});

test("run quality handles no output, concurrent runs, stopping, and inaccessible storage", () => {
  let time = 50;
  const runs = createRunQualityTracker(() => { throw new Error("storage disabled"); }, () => time);
  runs.start("one");
  runs.start("two");
  runs.stopping("one", true);
  expect(runs.isStopping("one")).toBe(true);
  time = 25;
  expect(runs.finish("one")).toMatchObject({ duration_ms: 0, time_to_first_output_ms: null, tool_call_count: 0 });
  expect(runs.isStopping("one")).toBe(false);
  expect(runs.output("missing")).toBe(false);
  expect(runs.finish("two", true).is_first_run_on_install).toBe(true);
  expect(runs.isFirstRun()).toBe(false);
});

test("updates are offered once per version and installed only after a matching version launches", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const events: { event: string; properties: Record<string, string | null> }[] = [];
  const capture = (event: string, properties: Record<string, string | null>) => { events.push({ event, properties }); };
  const updates = createUpdateAnalytics(() => storage, capture);
  updates.offered("1.0.0", "1.1.0");
  updates.offered("1.0.0", "1.1.0");
  expect(events.map(({ event }) => event)).toEqual(["update_offered"]);
  updates.installing("1.0.0", "1.1.0");
  updates.launched("1.0.0");
  expect(events).toHaveLength(1);
  const relaunched = createUpdateAnalytics(() => storage, capture);
  relaunched.launched("1.1.0");
  relaunched.launched("1.1.0");
  expect(events[1]).toEqual({ event: "update_installed", properties: { previous_version: "1.0.0", current_version: "1.1.0" } });
  expect(events).toHaveLength(2);
  updates.installing("1.1.0", "1.2.0");
  updates.cancelInstall();
  relaunched.launched("1.2.0");
  expect(events).toHaveLength(2);
  updates.failed("1.0.0", "download");
  expect(events[2]?.properties.reason).toBe("download_failed");
});

test("update telemetry accepts versions, never arbitrary error text, and tolerates blocked storage", () => {
  expect(analyticsVersion("0.18.1-alpha.3+build.4")).toBe("0.18.1-alpha.3+build.4");
  expect(analyticsVersion("secret /private/path")).toBeNull();
  const events: string[] = [];
  const updates = createUpdateAnalytics(() => { throw new Error("storage disabled"); }, (event) => { events.push(event); });
  updates.offered("private text", "private text");
  updates.installing("1.0.0", "1.1.0");
  updates.launched("1.1.0");
  updates.cancelInstall();
  expect(events).toEqual([]);
});
