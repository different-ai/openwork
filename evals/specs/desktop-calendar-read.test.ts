import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { eventually, needs, test } from "@openwork/testkit";
import { stopChild } from "../worlds/openwork-server-cli.ts";

// Both checks use the real local extension boundary with synthetic provider traffic.
async function calendarServer() {
  needs({ commands: ["bun"] });
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
    const requests = async () => (await fetch(witness, { signal: AbortSignal.timeout(10_000) })).json();
    const call = async (args: Record<string, unknown>) => {
      const response = await fetch(`${base}/experimental/extensions/call`, { method: "POST", headers: { authorization: "Bearer calendar-client", "content-type": "application/json" },
        body: JSON.stringify({ extensionId: "google-workspace", action: "calendar_list_events", args }), signal: AbortSignal.timeout(10_000) });
      return { status: response.status, body: await response.json() };
    };
    return { base, requests, call, [Symbol.asyncDispose]: async () => {
      await stopChild(child);
      await rm(root, { recursive: true, force: true });
    } };
  } catch (error) {
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

// Keep the valid compatibility corpus separately selectable for clean-dev comparison.
test("desktop Calendar valid compatibility corpus preserves dates and page sizes", async ({ evidence, place }) => {
  console.log(`placement: ${place.kind} (PR lane resolved by testkit)`);
  await using calendar = await calendarServer();
  const utc = { timeMin: "2026-09-01T07:00:00Z", timeMax: "2026-09-01T08:00:00Z" };
  const cases = [
    { label: "UTC default", args: utc, expected: { ...utc, maxResults: "10" } },
    { label: "positive offset", args: { timeMin: "2026-09-01T09:00:00+05:30", timeMax: "2026-09-01T10:00:00+05:30" }, expected: { timeMin: "2026-09-01T09:00:00+05:30", timeMax: "2026-09-01T10:00:00+05:30", maxResults: "10" } },
    { label: "negative offset", args: { timeMin: "2026-09-01T09:00:00-07:00", timeMax: "2026-09-01T10:00:00-07:00" }, expected: { timeMin: "2026-09-01T09:00:00-07:00", timeMax: "2026-09-01T10:00:00-07:00", maxResults: "10" } },
    { label: "UTC milliseconds", args: { timeMin: "2026-09-01T07:00:00.123Z", timeMax: "2026-09-01T08:00:00.456Z" }, expected: { timeMin: "2026-09-01T07:00:00.123Z", timeMax: "2026-09-01T08:00:00.456Z", maxResults: "10" } },
    { label: "offset fractional seconds", args: { timeMin: "2026-09-01T09:00:00.123456+05:30", timeMax: "2026-09-01T10:00:00.654321+05:30" }, expected: { timeMin: "2026-09-01T09:00:00.123456+05:30", timeMax: "2026-09-01T10:00:00.654321+05:30", maxResults: "10" } },
    { label: "surrounding whitespace", args: { timeMin: " 2026-09-01T07:00:00Z ", timeMax: " 2026-09-01T08:00:00Z " }, expected: { ...utc, maxResults: "10" } },
    ...[
      { label: "minimum", value: 1, expected: "1" },
      { label: "explicit default", value: 10, expected: "10" },
      { label: "maximum", value: 50, expected: "50" },
      { label: "zero clamps upward", value: 0, expected: "1" },
      { label: "negative clamps upward", value: -1, expected: "1" },
      { label: "above maximum clamps downward", value: 51, expected: "50" },
    ].map(({ label, value, expected }) => ({ label, args: { ...utc, maxResults: value }, expected: { ...utc, maxResults: expected } })),
  ];
  for (const entry of cases) {
    expect(await calendar.call(entry.args), entry.label).toMatchObject({ status: 200, body: { ok: true, result: { items: [{ id: "synthetic-event" }] } } });
  }
  expect(await calendar.requests()).toEqual(cases.map(({ expected }) => ({ ...expected, singleEvents: "true", orderBy: "startTime" })));
  evidence.recordAssertionEvidence("Valid Calendar compatibility corpus", "12 successful reads preserve UTC, positive and negative offsets, millisecond and six-digit fractions, whitespace trimming, omitted/explicit defaults, integer bounds and clamping. The provider witnesses exactly 12 ordered requests with exact time bounds, integer page sizes, singleEvents=true and orderBy=startTime.", true);
});

test("desktop Calendar reads validate arguments before provider access and preserve provider failures", async ({ evidence, place }) => {
  console.log(`placement: ${place.kind} (PR lane resolved by testkit)`);
  await using calendar = await calendarServer();
  const { base, requests, call } = calendar;
  const actionsResponse = await fetch(`${base}/experimental/extensions/actions?extensionId=google-workspace`, { headers: { authorization: "Bearer calendar-client" } });
  expect(actionsResponse.status).toBe(200);
  expect(await actionsResponse.json()).toMatchObject({ actions: expect.arrayContaining([expect.objectContaining({
    action: "calendar_list_events", inputSchema: expect.objectContaining({ properties: expect.objectContaining({
      timeMin: expect.objectContaining({ format: "date-time", description: expect.stringContaining("UTC offset") }),
      timeMax: expect.objectContaining({ format: "date-time", description: expect.stringContaining("later than timeMin") }),
      maxResults: expect.objectContaining({ type: "integer" }),
    }) }),
  })]) });
  const valid = { timeMin: "2026-09-01T09:00:00+02:00", timeMax: "2026-09-01T10:00:00+02:00" };
  const invalid = [
    { ...valid, maxResults: 2.5 }, { ...valid, maxResults: "many" },
    // Strings and null were formerly coerced but are outside the advertised numeric schema.
    { ...valid, maxResults: "10" }, { ...valid, maxResults: null },
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
  evidence.recordAssertionEvidence("Invalid Calendar arguments stop before provider access", "Discovery advertises integer page sizes and offset timestamps. Nine invalid date, range and page-size requests return 400 invalid_payload; the provider witness receives zero requests.", true);

  const providerError = await call({ ...valid, maxResults: 13 });
  expect(providerError.status).toBe(500);
  expect(providerError.body).toEqual({ code: "internal_error", message: "Unexpected server error" });
  expect(await requests()).toHaveLength(1);
  evidence.recordAssertionEvidence("Unrelated provider errors remain visible", "A valid request reaches the provider once; its synthetic 400 rejection remains an error and is not converted to empty success.", true);
});
