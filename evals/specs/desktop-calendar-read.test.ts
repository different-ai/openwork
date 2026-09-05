import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { eventually, needs, test } from "@openwork/testkit";
import { stopChild } from "../worlds/openwork-server-cli.ts";

// New boundary journey: the local extension's Calendar read, separate from Den's
// hosted Google capabilities. All Calendar traffic is intercepted by the witness.
test("desktop Calendar reads validate arguments before provider access and preserve valid requests", async ({ evidence, place }) => {
  needs({ commands: ["bun"] });
  console.log(`placement: ${place.kind} (PR lane resolved by testkit)`);
  const root = await mkdtemp(join(tmpdir(), "calendar-read-"));
  const repo = resolve(import.meta.dirname, "../..");
  const config = join(root, "server.json");
  const vault = join(root, "extensions", "google-workspace", "oauth.dev-plaintext.json");
  await mkdir(join(root, "extensions", "google-workspace"), { recursive: true });
  await writeFile(config, "{}");
  await writeFile(vault, JSON.stringify({ version: 2, activeAccountId: "fixture-account", accounts: [{
    account: { email: "calendar@example.test", name: "Calendar fixture", sub: "fixture-account", picture: null },
    scopes: ["openid", "https://www.googleapis.com/auth/calendar.readonly"],
    token: { accessToken: "calendar-fixture-token", refreshToken: "fixture-refresh", expiresAt: Date.now() + 3_600_000 },
    connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }] }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENWORK_|OPENCODE|GOOGLE_|SENTRY_)/.test(key)));
  const child = spawn("bun", ["--conditions=development", "--preload", join(repo, "evals/packages/labs/src/calendar-read-preload.ts"), "src/cli.ts",
    "--host", "127.0.0.1", "--port", "0", "--token", "calendar-client", "--host-token", "calendar-host", "--config", config,
  ], { cwd: join(repo, "apps/server"), env: { ...inherited, OPENWORK_SERVER_CONFIG: config, OPENWORK_DATA_DIR: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    OPENWORK_DEV_MODE: "1", OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT: "1",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  try {
    const base = await eventually(() => {
      if (child.exitCode !== null) throw new Error(output);
      return output.match(/OpenWork server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    }, { within: 60_000, intervalMs: 100 });
    const witness = output.match(/Calendar witness: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (!witness) throw new Error("Calendar witness did not start");
    const requests = async () => (await fetch(witness)).json();
    const actionsResponse = await fetch(`${base}/experimental/extensions/actions?extensionId=google-workspace`, { headers: { authorization: "Bearer calendar-client" } });
    expect(actionsResponse.status).toBe(200);
    expect(await actionsResponse.json()).toMatchObject({ actions: expect.arrayContaining([expect.objectContaining({
      action: "calendar_list_events", inputSchema: expect.objectContaining({ properties: expect.objectContaining({
        timeMin: expect.objectContaining({ format: "date-time", description: expect.stringContaining("UTC offset") }),
        timeMax: expect.objectContaining({ format: "date-time", description: expect.stringContaining("later than timeMin") }),
        maxResults: expect.objectContaining({ type: "integer" }),
      }) }),
    })]) });
    const call = async (args: Record<string, unknown>) => {
      const response = await fetch(`${base}/experimental/extensions/call`, { method: "POST", headers: { authorization: "Bearer calendar-client", "content-type": "application/json" },
        body: JSON.stringify({ extensionId: "google-workspace", action: "calendar_list_events", args }), signal: AbortSignal.timeout(10_000) });
      return { status: response.status, body: await response.json() };
    };
    const valid = { timeMin: "2026-09-01T09:00:00+02:00", timeMax: "2026-09-01T10:00:00+02:00" };
    const invalid = [
      { ...valid, maxResults: 2.5 }, { ...valid, maxResults: "many" },
      { ...valid, timeMin: "2026-09-01T09:00:00" }, { ...valid, timeMin: "2026-09-01" },
      { ...valid, timeMin: "2026-02-30T09:00:00Z" }, { ...valid, timeMax: valid.timeMin },
      { ...valid, timeMax: "2026-09-01T06:00:00Z" },
    ];
    for (const args of invalid) {
      const result = await call(args);
      expect(result.status, JSON.stringify({ result, providerRequests: await requests() })).toBe(400);
      expect(JSON.stringify(result.body)).toContain("invalid_payload");
    }
    expect(await requests()).toEqual([]);
    evidence.recordAssertionEvidence("Invalid Calendar arguments stop before provider access", "Discovery advertises integer page sizes and offset timestamps. Seven invalid date, range and page-size requests return 400 invalid_payload; the provider witness receives zero requests.", true);

    for (const args of [valid, { ...valid, maxResults: 50 }, { timeMin: "2026-09-01T07:00:00Z", timeMax: "2026-09-01T08:00:00Z", maxResults: 1 }]) {
      expect(await call(args)).toMatchObject({ status: 200, body: { ok: true, result: { items: [{ id: "synthetic-event" }] } } });
    }
    expect(await requests()).toEqual([
      { ...valid, maxResults: "10", singleEvents: "true", orderBy: "startTime" },
      { ...valid, maxResults: "50", singleEvents: "true", orderBy: "startTime" },
      { timeMin: "2026-09-01T07:00:00Z", timeMax: "2026-09-01T08:00:00Z", maxResults: "1", singleEvents: "true", orderBy: "startTime" },
    ]);
    evidence.recordAssertionEvidence("Valid offset and UTC reads preserve Calendar semantics", "Three reads return the synthetic event; exact queries retain offsets, the default and boundary page sizes, singleEvents=true and orderBy=startTime.", true);
    const providerError = await call({ ...valid, maxResults: 13 });
    expect(providerError.status).toBe(500);
    expect(providerError.body).toEqual({ code: "internal_error", message: "Unexpected server error" });
    expect(await requests()).toHaveLength(4);
    evidence.recordAssertionEvidence("Unrelated provider errors remain visible", "A valid request reaches the provider once; its synthetic 400 rejection remains an error and is not converted to empty success.", true);
  } finally {
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
  }
});
