import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { eventually, test } from "@openwork/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");
const serverDir = join(repoRoot, "apps", "server");

// Rollover reasons, reload triggers, and request timings are emitted by the
// in-process openwork-server through its logger. The packaged desktop has no
// visible stdout, so OPENWORK_SERVER_LOG_FILE must persist them as structured
// JSON lines without ever persisting a credential.

type BootedServer = { child: ChildProcess; output: () => string; stop: () => Promise<void> };

function bootServer(env: NodeJS.ProcessEnv, workspace: string, token?: string, preload?: string): BootedServer {
  const tokenArgs = token ? ["--token", token, "--host-token", `${token}-host`] : [];
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "openwork-server",
      "exec",
      "bun",
      "--conditions=development",
      ...(preload ? ["--preload", preload] : []),
      "src/cli.ts",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      ...tokenArgs,
      "--approval",
      "auto",
      "--cors",
      "*",
      "--workspace",
      workspace,
    ],
    { cwd: repoRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  return {
    child,
    output: () => output,
    stop: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null) return done();
        child.once("exit", () => done());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }),
  };
}

function listeningPort(output: string): number | null {
  const match = output.match(/OpenWork server listening on http:\/\/127\.0\.0\.1:(\d+)/);
  return match ? Number(match[1]) : null;
}

function jsonLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("openwork-server persists structured, credential-free logs when OPENWORK_SERVER_LOG_FILE is set", async ({ evidence }) => {
  const root = mkdtempSync(join(tmpdir(), "openwork-server-log-spec-"));
  const workspace = join(root, "workspace");
  const logFile = join(root, "userData", "logs", "openwork-server.log");
  const token = "client-token-must-not-persist";
  spawnSync("mkdir", ["-p", workspace]);

  const withSink = bootServer({ OPENWORK_SERVER_LOG_FILE: logFile, OPENWORK_LOG_FORMAT: "pretty" }, workspace, token);
  let withoutSink: BootedServer | null = null;
  let generatedSink: BootedServer | null = null;
  try {
    const port = await eventually(() => listeningPort(withSink.output()), { within: 60_000, intervalMs: 250 });
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);

    const lines = await eventually(() => (existsSync(logFile) ? jsonLines(logFile) : []), {
      within: 15_000,
      intervalMs: 250,
      until: (entries) => entries.some((entry) => String(entry.body).includes("GET /health 200")),
    });

    const listening = lines.find((entry) => String(entry.body).startsWith("OpenWork server listening on"));
    expect(listening, JSON.stringify(lines)).toBeDefined();
    expect(listening?.severityText).toBe("INFO");
    expect((listening?.resource as Record<string, unknown>)["service.name"]).toBe("openwork-server");
    expect(typeof (listening?.attributes as Record<string, unknown>)["run.id"]).toBe("string");
    expect(typeof (listening?.attributes as Record<string, unknown>)["process.pid"]).toBe("number");

    const request = lines.find((entry) => String(entry.body).includes("GET /health 200"));
    expect((request?.attributes as Record<string, unknown>).status).toBe(200);
    expect(typeof (request?.attributes as Record<string, unknown>).durationMs).toBe("number");

    const raw = readFileSync(logFile, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(`${token}-host`);
    // stdout keeps the human format: no JSON envelope leaks into the console.
    expect(withSink.output()).toContain("OpenWork server listening on");
    expect(withSink.output()).not.toContain("\"severityText\"");

    evidence.recordAssertionEvidence(
      "Server log lines are persisted as structured JSON",
      `${lines.length} JSON lines at ${logFile}, including the listening line and a request line with status and durationMs, while stdout stays in pretty format.`,
      true,
    );
    evidence.recordAssertionEvidence(
      "Persisted logs never carry the client or host token",
      "The explicit --token and --host-token values are absent from the file even though the server logged startup and a request.",
      true,
    );

    // Generated credentials are intentionally printed to CLI stdout so a
    // person can connect, but the persisted copy must redact those message
    // bodies. Attribute-key redaction alone cannot protect these lines.
    const generatedLog = join(root, "generated", "openwork-server.log");
    generatedSink = bootServer({ OPENWORK_SERVER_LOG_FILE: generatedLog, OPENWORK_LOG_FORMAT: "pretty" }, workspace);
    const generatedOutput = await eventually(() => generatedSink?.output() ?? "", {
      within: 60_000,
      intervalMs: 250,
      until: (output) => output.includes("Client token: ") && output.includes("Host token: "),
    });
    const generatedClient = generatedOutput.match(/Client token: (\S+)/)?.[1];
    const generatedHost = generatedOutput.match(/Host token: (\S+)/)?.[1];
    expect(generatedClient).toBeTruthy();
    expect(generatedHost).toBeTruthy();
    const generatedRaw = await eventually(() => (existsSync(generatedLog) ? readFileSync(generatedLog, "utf8") : ""), {
      within: 15_000,
      intervalMs: 250,
      until: (output) => output.includes("Client token: <redacted>") && output.includes("Host token: <redacted>"),
    });
    expect(generatedOutput).toContain(generatedClient);
    expect(generatedOutput).toContain(generatedHost);
    expect(generatedRaw).not.toContain(generatedClient);
    expect(generatedRaw).not.toContain(generatedHost);
    evidence.recordAssertionEvidence(
      "Generated startup credentials remain on stdout but are redacted from the file",
      "A real CLI boot without --token/--host-token printed both generated values for the operator; the JSON file contained only Client token: <redacted> and Host token: <redacted>.",
      true,
    );

    // Negative half: without the env the same server writes no file at all.
    const otherLog = join(root, "unset", "openwork-server.log");
    withoutSink = bootServer({ OPENWORK_SERVER_LOG_FILE: "" }, workspace, `${token}-2`);
    const otherPort = await eventually(() => listeningPort(withoutSink?.output() ?? ""), { within: 60_000, intervalMs: 250 });
    expect((await fetch(`http://127.0.0.1:${otherPort}/health`)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(existsSync(otherLog)).toBe(false);
    expect(existsSync(join(root, "unset"))).toBe(false);
    evidence.recordAssertionEvidence(
      "No file sink is created when OPENWORK_SERVER_LOG_FILE is unset",
      "A second server booted without the variable served /health and created neither a log file nor its directory.",
      true,
    );
  } finally {
    await withSink.stop();
    await withoutSink?.stop();
    await generatedSink?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const { code, stream } of [
  ...["ENOSPC", "EDQUOT", "EIO"].map((code) => ({ code, stream: "stdout" })),
  { code: "EIO", stream: "stderr" },
]) {
  for (const mode of stream === "stderr" ? ["async"] : ["sync", "async"]) {
    test(`openwork-server keeps serving requests after ${mode} ${stream} ${code}`, async ({ evidence }) => {
      const root = mkdtempSync(join(tmpdir(), "openwork-stdout-storage-spec-"));
      const logFile = join(root, "server.log");
      const server = bootServer({
        OPENWORK_SERVER_LOG_FILE: logFile,
        OPENWORK_TEST_STDOUT_ERROR: code,
        OPENWORK_TEST_STDOUT_MODE: mode,
        OPENWORK_TEST_STDOUT_STREAM: stream,
      }, root, "storage-fault-test-token", join(repoRoot, "evals/packages/labs/src/fixtures/stdout-storage-fault.mjs"));
      try {
        const port = await eventually(() => listeningPort(server.output()), { within: 60_000, intervalMs: 250 });
        const url = `http://127.0.0.1:${port}/health`;
        expect((await fetch(url)).status).toBe(200);
        await eventually(() => server.output(), {
          within: 5_000,
          intervalMs: 50,
          until: (output) => output.includes(`${stream}-storage-fault:${code}`),
        });
        // A second request proves the failed output cannot kill the server or
        // prevent the independent structured file sink from recording requests.
        expect((await fetch(url)).status).toBe(200);
        const requests = await eventually(() => jsonLines(logFile).filter((entry) => String(entry.body).includes("GET /health 200")), {
          within: 5_000,
          intervalMs: 50,
          until: (entries) => entries.length === 2,
        });
        expect(requests).toHaveLength(2);
        expect(server.child.exitCode).toBeNull();
        expect(server.output().split(`${stream}-storage-fault:${code}`)).toHaveLength(2);
        evidence.recordAssertionEvidence(
          `Requests survive ${mode} ${stream} ${code}`,
          `Two real HTTP health requests returned 200; the injected ${stream} failure occurred exactly once, the process stayed alive, and both requests reached the independent JSON file sink.`,
          true,
        );
      } finally {
        await server.stop();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
