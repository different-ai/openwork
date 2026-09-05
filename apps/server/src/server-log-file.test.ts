import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServerLogger } from "./server.js";
import {
  createServerLogFileSink,
  redactLogAttributes,
  resetServerLogFileSinkForTests,
  resolveServerLogFileSink,
  SERVER_LOG_FILE_ENV,
} from "./server-log-file.js";
import type { ServerConfig } from "./types.js";

function serverConfig(logFormat: ServerConfig["logFormat"] = "pretty"): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 30000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat,
    logRequests: true,
  };
}

const tempDirs: string[] = [];

function tempLogPath() {
  const dir = mkdtempSync(join(tmpdir(), "openwork-server-log-"));
  tempDirs.push(dir);
  return join(dir, "nested", "openwork-server.log");
}

async function settled(sink: { close: () => void }) {
  sink.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

afterEach(() => {
  resetServerLogFileSinkForTests();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createServerLogFileSink", () => {
  test("creates the parent directory and appends one line per write", async () => {
    const path = tempLogPath();
    const sink = createServerLogFileSink({ path });
    sink.write("first");
    sink.write("second");
    await settled(sink);

    expect(readFileSync(path, "utf8")).toBe("first\nsecond\n");
  });

  test("rotates to .1 once the cap is reached and keeps a single previous file", async () => {
    const path = tempLogPath();
    const sink = createServerLogFileSink({ path, maxBytes: 12 });
    sink.write("aaaaa"); // 6 bytes
    sink.write("bbbbb"); // 12 bytes -> at cap
    sink.write("ccccc"); // rotates first, then writes
    sink.write("ddddd"); // 12 bytes -> at cap again
    sink.write("eeeee"); // rotates again; the older .1 is dropped
    await settled(sink);

    expect(readFileSync(path, "utf8")).toBe("eeeee\n");
    expect(readFileSync(`${path}.1`, "utf8")).toBe("ccccc\nddddd\n");
    expect(existsSync(`${path}.2`)).toBe(false);
  });
});

describe("redactLogAttributes", () => {
  test("replaces credential-looking keys and leaves the rest intact", () => {
    expect(redactLogAttributes({
      "engine.rollover.reason": "engine_reload",
      Authorization: "Bearer abc",
      "mcp.headers.authorization": "Bearer abc",
      apiKey: "sk-live",
      api_key: "sk-live",
      "connect.token": "tok",
      password: "hunter2",
      "workspace.id": "ws_1",
      "process.pid": 42,
      "auth.mode": null,
    })).toEqual({
      "engine.rollover.reason": "engine_reload",
      Authorization: "<redacted>",
      "mcp.headers.authorization": "<redacted>",
      apiKey: "<redacted>",
      api_key: "<redacted>",
      "connect.token": "<redacted>",
      password: "<redacted>",
      "workspace.id": "ws_1",
      "process.pid": 42,
      "auth.mode": null,
    });
  });
});

describe("createServerLogger file sink", () => {
  test("mirrors structured JSON to the file while stdout keeps the pretty format", async () => {
    const path = tempLogPath();
    const sink = createServerLogFileSink({ path });
    const stdout: string[] = [];
    const logger = createServerLogger(serverConfig("pretty"), (line) => stdout.push(line), sink);

    logger.log("info", "Engine rollover requested.", {
      "engine.rollover.reason": "engine_reload",
      Authorization: "Bearer should-not-persist",
    });
    await settled(sink);

    expect(stdout).toEqual(["Engine rollover requested."]);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}");
    expect(record.body).toBe("Engine rollover requested.");
    expect(record.severityText).toBe("INFO");
    expect(record.attributes["engine.rollover.reason"]).toBe("engine_reload");
    expect(record.attributes.Authorization).toBe("<redacted>");
    expect(record.resource["service.name"]).toBe("openwork-server");
    expect(readFileSync(path, "utf8")).not.toContain("should-not-persist");
  });

  test("keeps generated credentials on stdout but removes them from file messages and nested attributes", async () => {
    const path = tempLogPath();
    const sink = createServerLogFileSink({ path });
    const stdout: string[] = [];
    const config = serverConfig("json");
    config.token = "generated-client-token";
    config.hostToken = "generated-host-token";
    config.opencodePassword = "generated-engine-password";
    const logger = createServerLogger(config, (line) => stdout.push(line), sink);

    logger.log("info", `Client token: ${config.token}`, {
      detail: {
        message: `host=${config.hostToken} engine=${config.opencodePassword}`,
      },
    });
    await settled(sink);

    // CLI stdout remains usable: generated credentials are how a person
    // connects when no explicit --token/--host-token was supplied.
    expect(stdout.join("\n")).toContain(config.token);
    expect(stdout.join("\n")).toContain(config.hostToken);
    const persisted = readFileSync(path, "utf8");
    expect(persisted).not.toContain(config.token);
    expect(persisted).not.toContain(config.hostToken);
    expect(persisted).not.toContain(config.opencodePassword);
    const record = JSON.parse(persisted);
    expect(record.body).toBe("Client token: <redacted>");
    expect(record.attributes.detail.message).toBe("host=<redacted> engine=<redacted>");
  });

  test("writes nothing to disk when no sink is configured", () => {
    const stdout: string[] = [];
    const logger = createServerLogger(serverConfig("json"), (line) => stdout.push(line), null);
    logger.log("warn", "no file", { token: "abc" });

    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? "{}").attributes.token).toBe("<redacted>");
  });
});

describe("resolveServerLogFileSink", () => {
  test(`is null without ${SERVER_LOG_FILE_ENV} and memoizes one sink per process when set`, () => {
    expect(resolveServerLogFileSink({})).toBeNull();
    resetServerLogFileSinkForTests();

    const path = tempLogPath();
    const first = resolveServerLogFileSink({ [SERVER_LOG_FILE_ENV]: ` ${path} ` });
    const second = resolveServerLogFileSink({ [SERVER_LOG_FILE_ENV]: "/somewhere/else.log" });
    expect(first?.path).toBe(path);
    expect(second).toBe(first);
  });
});
