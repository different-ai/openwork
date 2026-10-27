import { expect, test } from "vitest";
import { formatHeadlessHealthTimeout } from "@openwork/world";

const healthLines = Array.from({ length: 80 }, () => "GET /health 503 0ms");

test("a health timeout names the failing probe, process states, host load and redacted log tails", () => {
  const message = formatHeadlessHealthTimeout({
    timeoutMs: 45_000,
    server: {
      probe: "answered 503",
      process: "running",
      logPath: "/runtime/server.log",
      log: ["Reload watcher enabled (1)", ...healthLines, "Engine token client-token-123 rejected", ""].join("\n"),
    },
    web: {
      probe: "unreachable (ECONNREFUSED)",
      process: "killed by SIGKILL",
      logPath: "/runtime/web.log",
      log: ["\x1b[32mVITE ready\x1b[0m", "(!) %VITE_SENTRY_DSN% is not defined", "(!) %VITE_SENTRY_DSN% is not defined", ""].join("\n"),
    },
    host: "load 9.0/6.0/3.0 on 4 CPUs; 120 MiB of 7900 MiB memory free",
    secrets: ["client-token-123", "host-token-456"],
  });
  expect(message.split("\n")).toEqual([
    "Headless web did not become healthy within 45 s.",
    "  server /health: answered 503; process running",
    "  web: unreachable (ECONNREFUSED); process killed by SIGKILL",
    "  host: load 9.0/6.0/3.0 on 4 CPUs; 120 MiB of 7900 MiB memory free",
    "--- end of /runtime/server.log (80 /health requests left out) ---",
    "Reload watcher enabled (1)",
    "Engine token [redacted] rejected",
    "--- end of /runtime/web.log ---",
    "VITE ready",
    "(!) %VITE_SENTRY_DSN% is not defined (2 times)",
  ]);
});

test("log tails stay short enough for the CI window", () => {
  const message = formatHeadlessHealthTimeout({
    timeoutMs: 45_000,
    server: { probe: "no answer within 1.5 s", process: "exited with code 1", logPath: "/runtime/server.log", log: null },
    web: {
      probe: "answered 200",
      process: "running",
      logPath: "/runtime/web.log",
      log: [...Array.from({ length: 40 }, (_, index) => `line ${index}`), "x".repeat(1_000)].join("\n"),
    },
    host: "load 1.0/1.0/1.0 on 4 CPUs; 4000 MiB of 7900 MiB memory free",
    secrets: [],
  });
  const lines = message.split("\n");
  expect(lines).toContain("--- /runtime/server.log: unreadable ---");
  expect(lines).toContain("--- end of /runtime/web.log ---");
  expect(lines).not.toContain("line 28");
  expect(lines.at(-1)).toBe(`${"x".repeat(300)}…`);
  expect(lines.length).toBeLessThanOrEqual(20);
});
