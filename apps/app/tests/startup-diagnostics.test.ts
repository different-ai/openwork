import { describe, expect, test } from "bun:test";
import { desktopStartupReportSchema, type DesktopStartupReport } from "@openwork/types/den/diagnostics";

import { DenApiError } from "../src/app/lib/den";
import type { DesktopStartupTimings } from "../src/app/lib/desktop";
import {
  STARTUP_DEADLINE_MS,
  STARTUP_PENDING_MAX_AGE_MS,
  STARTUP_PENDING_STORAGE_KEY,
  classifyStartupError,
  createStartupDiagnostics,
  sanitizeStartupAppVersion,
  startupPlatform,
  startupSendOutcomeForStatus,
  type StartupReportTarget,
  type StartupSendOutcome,
} from "../src/app/lib/startup-diagnostics";

const T0 = Date.parse("2026-10-20T09:00:00.000Z");
const DEN = "https://den.example.test";
const SESSION = { baseUrl: DEN, organizationId: "org_a" };

type Sent = { report: DesktopStartupReport; target: StartupReportTarget };

function launchTimings(startedAt: number): DesktopStartupTimings {
  return { processStartedAt: startedAt, windowShownAt: startedAt + 800, engineSettledAt: startedAt + 1_500, engine: "ready" };
}

function createLaunch(options: {
  startedAt?: number;
  timings?: DesktopStartupTimings | null;
  storage?: Map<string, string>;
  enabled?: boolean;
  sendResult?: StartupSendOutcome;
  timeOrigin?: number;
} = {}) {
  const startedAt = options.startedAt ?? T0;
  let now = startedAt + 1_000;
  let timings = options.timings === undefined ? launchTimings(startedAt) : options.timings;
  const storage = options.storage ?? new Map<string, string>();
  const sent: Sent[] = [];
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  let timingReads = 0;
  let nextId = 0;

  const diagnostics = createStartupDiagnostics({
    enabled: () => options.enabled ?? true,
    readTimings: async () => {
      timingReads += 1;
      return timings ? { ...timings } : null;
    },
    readAppVersion: async () => "0.18.3",
    readPlatform: () => "darwin",
    send: async (report, target) => {
      sent.push({ report, target });
      return options.sendResult ?? "sent";
    },
    storage: () => ({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: (key) => { storage.delete(key); },
    }),
    now: () => now,
    timeOrigin: () => options.timeOrigin ?? startedAt + 200,
    randomId: () => `0b6f5a3e-8c1d-4f2a-9e7b-${String(startedAt + nextId++).slice(-12).padStart(12, "0")}`,
    schedule: (run, delayMs) => {
      const timer = { at: now + delayMs, run, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  });

  return {
    diagnostics,
    storage,
    sent,
    timingReads: () => timingReads,
    setTimings(next: DesktopStartupTimings | null) {
      timings = next;
    },
    /** Lets queued work finish, moves the clock to `startedAt + ms` and fires due timers. */
    async at(ms: number) {
      await diagnostics.idle();
      now = startedAt + ms;
      for (;;) {
        const due = timers.filter((timer) => !timer.cancelled && timer.at <= now);
        if (due.length === 0) break;
        for (const timer of due) {
          timer.cancelled = true;
          timer.run();
        }
        await diagnostics.idle();
      }
    },
    pending(): unknown {
      const raw = storage.get(STARTUP_PENDING_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    },
  };
}

function expectValidReport(report: DesktopStartupReport) {
  expect(desktopStartupReportSchema.safeParse(report).success).toBe(true);
}

describe("startup report", () => {
  test("a launch that connects reports each step from process start, once", async () => {
    const launch = createLaunch();
    launch.diagnostics.denSession(SESSION);
    await launch.at(2_000);
    launch.diagnostics.markStep("engine");
    await launch.at(2_200);
    // Tools loaded with the stored session before the session check finished.
    launch.diagnostics.markStep("org_tools");
    await launch.at(2_500);
    expect(launch.sent).toEqual([]);
    launch.diagnostics.markStep("signed_in", { organizationId: "org_a" });
    await launch.at(3_000);
    launch.diagnostics.markStep("org_tools");
    await launch.at(STARTUP_DEADLINE_MS + 1_000);

    expect(launch.sent).toHaveLength(1);
    const [{ report, target }] = launch.sent;
    expectValidReport(report);
    expect(target).toEqual({ denBaseUrl: DEN, organizationId: "org_a" });
    expect(report).toMatchObject({
      appVersion: "0.18.3",
      platform: "darwin",
      observedAt: new Date(T0).toISOString(),
      success: true,
      // The engine settled in the main process before the renderer heard of
      // it; the tools count once the member is signed in.
      steps: { window: 800, engine: 1_500, signed_in: 2_500, org_tools: 2_500 },
      failedStep: null,
      reason: null,
    });
    expect(launch.pending()).toBeNull();
  });

  test("an engine that does not start ends the report at the engine step", async () => {
    const launch = createLaunch({ timings: { ...launchTimings(T0), engineSettledAt: T0 + 4_000, engine: "failed" } });
    launch.diagnostics.denSession(SESSION);
    await launch.at(4_100);
    launch.diagnostics.fail("engine", "engine_failed");
    launch.diagnostics.markStep("signed_in");
    await launch.at(5_000);

    expect(launch.sent).toHaveLength(1);
    expectValidReport(launch.sent[0].report);
    expect(launch.sent[0].report).toMatchObject({
      success: false,
      failedStep: "engine",
      reason: "engine_failed",
      steps: { window: 800, engine: null },
    });
  });

  test("a member who is not signed in sends and stores nothing", async () => {
    const launch = createLaunch();
    launch.diagnostics.denSession(null);
    launch.diagnostics.markStep("engine");
    launch.diagnostics.fail("signed_in", "unknown");
    await launch.at(STARTUP_DEADLINE_MS * 2);

    expect(launch.sent).toEqual([]);
    expect(launch.pending()).toBeNull();
    expect(launch.timingReads()).toBe(0);
  });

  test("the web app sends nothing", async () => {
    const launch = createLaunch({ enabled: false });
    launch.diagnostics.denSession(SESSION);
    launch.diagnostics.markStep("engine");
    await launch.at(STARTUP_DEADLINE_MS * 2);
    expect(launch.sent).toEqual([]);
    expect(launch.pending()).toBeNull();
  });

  test("an expired session fails the signed-in step as session_expired", async () => {
    const launch = createLaunch();
    launch.diagnostics.denSession(SESSION);
    launch.diagnostics.markStep("engine");
    await launch.at(2_000);
    launch.diagnostics.fail("signed_in", classifyStartupError(new DenApiError(401, "session_expired", "Session expired.")));
    // The provider then clears the token; that is the same failure.
    launch.diagnostics.denSession(null);
    await launch.at(3_000);

    expect(launch.sent).toHaveLength(1);
    expect(launch.sent[0].report).toMatchObject({ success: false, failedStep: "signed_in", reason: "session_expired" });
  });

  test("a launch that never connects times out at the first step it did not reach", async () => {
    const launch = createLaunch();
    launch.diagnostics.denSession(SESSION);
    launch.diagnostics.markStep("engine");
    await launch.at(STARTUP_DEADLINE_MS - 1);
    expect(launch.sent).toEqual([]);
    await launch.at(STARTUP_DEADLINE_MS);

    expect(launch.sent).toHaveLength(1);
    expectValidReport(launch.sent[0].report);
    expect(launch.sent[0].report).toMatchObject({ success: false, failedStep: "signed_in", reason: "timeout" });
  });

  test("organization tools that fail to load time out as org_unavailable", async () => {
    const launch = createLaunch();
    launch.diagnostics.denSession(SESSION);
    launch.diagnostics.markStep("engine");
    launch.diagnostics.markStep("signed_in");
    launch.diagnostics.orgToolsFailed();
    await launch.at(STARTUP_DEADLINE_MS);

    expect(launch.sent.map(({ report }) => [report.failedStep, report.reason])).toEqual([["org_tools", "org_unavailable"]]);
  });

  test("an unfinished launch is stored and sent as a failure after the next launch signs in", async () => {
    const storage = new Map<string, string>();
    const first = createLaunch({ storage });
    first.diagnostics.denSession(SESSION);
    first.diagnostics.markStep("engine");
    await first.at(2_000);
    first.diagnostics.markStep("signed_in", { organizationId: "org_a" });
    await first.at(2_500);
    // The app quits before the tools load.
    expect(first.sent).toEqual([]);
    expect(first.pending()).toMatchObject({
      version: 1,
      launchStartedAt: T0,
      denBaseUrl: DEN,
      organizationId: "org_a",
      finished: false,
      report: { steps: { window: 800, engine: 1_000, signed_in: 2_000, org_tools: null } },
    });
    const firstRecord = storage.get(STARTUP_PENDING_STORAGE_KEY);

    const T1 = T0 + 3_600_000;
    const second = createLaunch({ storage, startedAt: T1 });
    second.diagnostics.denSession(SESSION);
    second.diagnostics.markStep("engine");
    await second.at(1_200);
    // The slot keeps the old record until it has been offered.
    expect(storage.get(STARTUP_PENDING_STORAGE_KEY)).toBe(firstRecord);
    second.diagnostics.markStep("signed_in", { organizationId: "org_a" });
    await second.at(1_500);

    expect(second.sent).toHaveLength(1);
    const [{ report, target }] = second.sent;
    expectValidReport(report);
    expect(target).toEqual({ denBaseUrl: DEN, organizationId: "org_a" });
    expect(report).toMatchObject({
      observedAt: new Date(T0).toISOString(),
      success: false,
      failedStep: "org_tools",
      reason: "unknown",
      steps: { window: 800, engine: 1_000, signed_in: 2_000, org_tools: null },
    });
    // The second launch now owns the slot.
    expect(second.pending()).toMatchObject({ launchStartedAt: T1, finished: false });

    second.diagnostics.markStep("org_tools");
    await second.at(2_000);
    expect(second.sent).toHaveLength(2);
    expect(second.sent[1].report.success).toBe(true);
    expect(second.sent[1].report.attemptId).not.toBe(report.attemptId);
    expect(second.pending()).toBeNull();
  });

  test("a report Den could not receive is kept and sent by the next launch", async () => {
    const storage = new Map<string, string>();
    const first = createLaunch({ storage, sendResult: "retry" });
    first.diagnostics.denSession(SESSION);
    first.diagnostics.markStep("engine");
    first.diagnostics.markStep("signed_in");
    first.diagnostics.markStep("org_tools");
    await first.at(2_000);
    expect(first.sent).toHaveLength(1);
    expect(first.pending()).toMatchObject({ finished: true, report: { success: true } });

    const second = createLaunch({ storage, startedAt: T0 + 86_400_000 });
    second.diagnostics.denSession(SESSION);
    second.diagnostics.markStep("signed_in");
    await second.at(1_500);
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0].report).toEqual(first.sent[0].report);
  });

  test("a record from another Den is not sent to this one", async () => {
    const storage = new Map<string, string>();
    const first = createLaunch({ storage });
    first.diagnostics.denSession({ baseUrl: "https://other-den.example.test", organizationId: "org_b" });
    await first.at(2_000);

    const second = createLaunch({ storage, startedAt: T0 + 60_000 });
    second.diagnostics.denSession(SESSION);
    second.diagnostics.markStep("signed_in");
    await second.at(1_500);
    expect(second.sent).toEqual([]);
    expect(second.pending()).toMatchObject({ denBaseUrl: DEN, launchStartedAt: T0 + 60_000 });
  });

  test("records older than seven days are discarded", async () => {
    const storage = new Map<string, string>();
    const first = createLaunch({ storage });
    first.diagnostics.denSession(SESSION);
    await first.at(2_000);
    expect(first.pending()).not.toBeNull();

    const second = createLaunch({ storage, startedAt: T0 + STARTUP_PENDING_MAX_AGE_MS + 60_000 });
    second.diagnostics.denSession(SESSION);
    expect(second.pending()).toBeNull();
    second.diagnostics.markStep("signed_in");
    await second.at(1_500);
    expect(second.sent).toEqual([]);
  });

  test("a renderer reload during startup continues the same launch's report", async () => {
    const storage = new Map<string, string>();
    const first = createLaunch({ storage });
    first.diagnostics.denSession(SESSION);
    first.diagnostics.markStep("engine");
    await first.at(1_800);
    const firstRecord = first.pending();

    // Same process, new document: the window was shown before it loaded.
    const reloaded = createLaunch({ storage, timeOrigin: T0 + 5_000 });
    await reloaded.at(5_500);
    reloaded.diagnostics.denSession(SESSION);
    await reloaded.at(6_000);
    reloaded.diagnostics.markStep("engine");
    reloaded.diagnostics.markStep("signed_in");
    reloaded.diagnostics.markStep("org_tools");
    await reloaded.at(6_500);

    expect(reloaded.sent).toHaveLength(1);
    const [{ report }] = reloaded.sent;
    expect(firstRecord).toMatchObject({ report: { attemptId: report.attemptId } });
    expect(report).toMatchObject({ success: true, steps: { window: 800, engine: 1_000, signed_in: 6_000, org_tools: 6_000 } });
  });

  test("a renderer reload after the launch was reported measures nothing", async () => {
    const reloaded = createLaunch({ timeOrigin: T0 + 600_000 });
    reloaded.diagnostics.denSession(SESSION);
    reloaded.diagnostics.markStep("engine");
    reloaded.diagnostics.markStep("signed_in");
    reloaded.diagnostics.markStep("org_tools");
    await reloaded.at(STARTUP_DEADLINE_MS * 10);
    expect(reloaded.sent).toEqual([]);
    expect(reloaded.pending()).toBeNull();
  });

  test("without main-process timings the renderer start is the launch start and the window is not measured", async () => {
    const launch = createLaunch({ timings: null, timeOrigin: T0 + 200 });
    launch.diagnostics.denSession(SESSION);
    launch.diagnostics.markStep("engine");
    await launch.at(STARTUP_DEADLINE_MS + 200);
    expect(launch.sent[0].report).toMatchObject({
      success: false,
      failedStep: "signed_in",
      reason: "timeout",
      steps: { window: null, engine: 800 },
    });
  });
});

describe("report fields", () => {
  test("app versions are sanitized to what Den accepts", () => {
    const pattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
    const cases: [string | null, string][] = [
      ["0.18.3", "0.18.3"],
      ["0.18.3-alpha.2+build.7", "0.18.3-alpha.2+build.7"],
      ["0.18.3 (beta)/x", "0.18.3--beta--x"],
      ["  -v1.0  ", "v1.0"],
      ["", "unknown"],
      [null, "unknown"],
      ["///", "unknown"],
    ];
    for (const [raw, expected] of cases) {
      expect(sanitizeStartupAppVersion(raw)).toBe(expected);
      expect(pattern.test(sanitizeStartupAppVersion(raw))).toBe(true);
    }
    const long = sanitizeStartupAppVersion(`1.${"9".repeat(100)}`);
    expect(long).toHaveLength(64);
    expect(pattern.test(long)).toBe(true);
  });

  test("platforms map to Den's values", () => {
    expect(startupPlatform("darwin")).toBe("darwin");
    expect(startupPlatform("MacIntel")).toBe("darwin");
    expect(startupPlatform("windows")).toBe("win32");
    expect(startupPlatform("Win32")).toBe("win32");
    expect(startupPlatform("Linux x86_64")).toBe("linux");
    expect(startupPlatform("FreeBSD")).toBe("other");
    expect(startupPlatform(null)).toBe("other");
  });

  test("failed Den requests are classified", () => {
    const ipc = (message: string) => new Error(`Error invoking remote method 'openwork:desktop': Error: ${message}`);
    const withCode = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

    expect(classifyStartupError(new DenApiError(401, "unauthorized", "Unauthorized"), true)).toBe("session_expired");
    expect(classifyStartupError(new DenApiError(502, "bad_gateway", "Bad gateway"), true)).toBe("server_error");
    expect(classifyStartupError(new DenApiError(503, "unavailable", "Unavailable"), false)).toBe("server_error");
    expect(classifyStartupError(ipc("net::ERR_NAME_NOT_RESOLVED"), false)).toBe("offline");
    expect(classifyStartupError(ipc("net::ERR_CERT_AUTHORITY_INVALID"), true)).toBe("certificate");
    expect(classifyStartupError(withCode("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), true)).toBe("certificate");
    expect(classifyStartupError(withCode("SELF_SIGNED_CERT_IN_CHAIN"), true)).toBe("certificate");
    expect(classifyStartupError(withCode("CERT_HAS_EXPIRED"), true)).toBe("certificate");
    expect(classifyStartupError(ipc("net::ERR_NAME_NOT_RESOLVED"), true)).toBe("dns");
    expect(classifyStartupError(withCode("ENOTFOUND"), true)).toBe("dns");
    expect(classifyStartupError(withCode("EAI_AGAIN"), true)).toBe("dns");
    expect(classifyStartupError(ipc("net::ERR_INTERNET_DISCONNECTED"), true)).toBe("offline");
    expect(classifyStartupError(withCode("ECONNREFUSED"), true)).toBe("connection_refused");
    expect(classifyStartupError(ipc("net::ERR_CONNECTION_REFUSED"), true)).toBe("connection_refused");
    expect(classifyStartupError(new Error("Request timed out."), true)).toBe("timeout");
    expect(classifyStartupError(withCode("ETIMEDOUT"), true)).toBe("timeout");
    expect(classifyStartupError(new DOMException("The operation was aborted.", "AbortError"), true)).toBe("timeout");
    expect(classifyStartupError(new DenApiError(403, "forbidden", "Forbidden"), true)).toBe("unknown");
    expect(classifyStartupError(new Error("Certainly not a known failure"), true)).toBe("unknown");
  });

  test("only refusals that will not change are dropped", () => {
    expect(startupSendOutcomeForStatus(204)).toBe("sent");
    expect(startupSendOutcomeForStatus(404)).toBe("drop");
    expect(startupSendOutcomeForStatus(400)).toBe("drop");
    expect(startupSendOutcomeForStatus(401)).toBe("retry");
    expect(startupSendOutcomeForStatus(429)).toBe("retry");
    expect(startupSendOutcomeForStatus(503)).toBe("retry");
  });
});
