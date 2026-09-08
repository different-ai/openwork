import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { eventually, localMysqlIsRunning, queryDenDatabase, server, test } from "@openwork/testkit";

// This journey exercises the protected retention HTTP boundary and real MySQL,
// never a production database or an in-memory approximation of locking.
const local = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL;
const mysql = await localMysqlIsRunning();
const title = !local ? "accounting skipped: needs isolated local placement"
  : !mysql ? "accounting skipped: needs scratch MySQL on 127.0.0.1:3306"
    : "retention consumes bounded source batches once, including late arrivals, competing workers and rollback";

test.skipIf(!local || !mysql)(title, { timeout: 600_000 }, async ({ place, evidence }) => {
  await using den = await server({ place, web: false, org: { name: "Accounting retention fixture" } });
  const databaseUrl = den.database?.url;
  if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("Isolated scratch DB required");
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("Port unavailable")));
    });
  });
  const child = spawn("pnpm", ["--dir", "ee/apps/gateway", "exec", "tsx", "test/helpers/accounting-server.ts"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "--conditions=development",
      DATABASE_URL: databaseUrl, PORT: String(port), SENTRY_DSN: "", SENTRY_LOG_LEVEL: "off" },
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
  });
  const origin = `http://127.0.0.1:${port}`;
  const request = (path: string, body?: object, authorized = true) => fetch(`${origin}${path}`, {
    method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", ...(authorized ? { authorization: "Bearer accounting-test-only" } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const run = () => request("/internal/rollups/run", { now: "2026-09-07T00:00:00.000Z", maxBucketsPerRun: 1, maxSourceRowsPerBucket: 1 });
  let sequence = 0;
  const seed = async (tokens: number, hour = 0, member = "om_00000000000000000000000001", model = "model-a", known = true) => {
    const id = `irl_${String(++sequence).padStart(26, "0")}`;
    await queryDenDatabase(databaseUrl,
      `INSERT INTO inference_request_logs
       (id, organization_id, org_membership_id, inference_key_id, route, protocol, upstream_provider_id,
        upstream_host, upstream_path, method, upstream_model, stream, outcome, usage_source,
        input_tokens, output_tokens, total_tokens, cost_micro_usd, started_at, completed_at, first_byte_at, openwork_request_id)
       VALUES (?, 'org_00000000000000000000000001', ?, 'ink_00000000000000000000000001', 'org_provider', 'openai_chat', 'openai',
        'upstream.invalid', '/chat/completions', 'POST', ?, false, 'ok', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      [id, member, model, known ? "json" : "missing", known ? tokens : null, known ? tokens : null, known ? 0 : null,
        `2026-01-01 ${String(hour).padStart(2, "0")}:00:00`, known ? `2026-01-01 ${String(hour).padStart(2, "0")}:00:00` : null,
        known ? `2026-01-01 ${String(hour).padStart(2, "0")}:00:00` : null, id]);
  };
  const rows = () => queryDenDatabase(databaseUrl,
    "SELECT granularity, org_membership_id, upstream_model, input_tokens, request_count, cost_count, cost_micro_usd, latency_count, ttfb_count, source_row_count FROM inference_usage_rollups WHERE organization_id = 'org_00000000000000000000000001' ORDER BY org_membership_id, upstream_model, granularity");
  const rawCount = async () => queryDenDatabase(databaseUrl, "SELECT count(*) AS n FROM inference_request_logs WHERE organization_id = 'org_00000000000000000000000001'");
  try {
    await eventually(async () => {
      if (child.exitCode !== null) throw new Error("Accounting fixture exited");
      return (await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(2000) })).ok;
    }, { within: 60_000, intervalMs: 250, label: "accounting HTTP boundary" });
    await seed(100);
    expect((await request("/internal/rollups/run", {}, false)).status).toBe(401);
    expect(await rows()).toHaveLength(0);
    expect(await rawCount()).toEqual([{ n: 1 }]);
    expect((await run()).status).toBe(200);
    await seed(7);
    expect((await run()).status).toBe(200);
    expect(await rows()).toMatchObject([{ granularity: "day", input_tokens: 107, request_count: 2 }]);
    expect((await run()).status).toBe(200);
    expect(await rows()).toMatchObject([{ input_tokens: 107, request_count: 2 }]);
    evidence.recordAssertionEvidence("Late consumption is additive, replay is not", "100 then 7 retains 107 in a day row; an empty rerun adds nothing; unauthorized caller consumes nothing", true);

    // Two old hours and a row-bound of one: compact day between every batch.
    await seed(11, 1);
    await seed(13, 2);
    expect((await run()).status).toBe(200);
    expect(await rows()).toMatchObject([{ input_tokens: 118 }]);
    expect(await rawCount()).toEqual([{ n: 1 }]);
    expect((await run()).status).toBe(200);
    expect(await rows()).toMatchObject([{ input_tokens: 131 }]);

    // Roll back AFTER the additive destination write, before source deletion.
    await seed(17, 3);
    await request("/test/fault", { fail: true });
    expect((await run()).status).toBe(500);
    expect(await rows()).toMatchObject([{ input_tokens: 131 }]);
    expect(await rows()).toHaveLength(1);
    expect(await rawCount()).toEqual([{ n: 1 }]);
    expect((await run()).status).toBe(200);
    expect(await rows()).toMatchObject([{ input_tokens: 148 }]);

    // Worker B waits for A's DB mutex while a writer inserts in the claimed
    // hour. InnoDB gap locks may also block the writer; neither ordering loses it.
    await seed(19, 4);
    await request("/test/fault", { hold: true });
    const first = run();
    await eventually(async () => {
      const state: unknown = await (await fetch(`${origin}/test/barrier`)).json();
      return typeof state === "object" && state !== null && "reached" in state && state.reached === true;
    }, { within: 10_000, intervalMs: 50, label: "source locked before consumption" });
    let competingFinished = false;
    const second = run().then((response) => { competingFinished = true; return response; });
    const writer = seed(23, 4);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(competingFinished).toBe(false);
    await request("/test/release");
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    await writer;
    for (let i = 0; i < 3; i += 1) expect((await run()).status).toBe(200);
    expect(await rawCount()).toEqual([{ n: 0 }]);
    expect(await rows()).toMatchObject([{ input_tokens: 190, request_count: 7, source_row_count: 7 }]);
    evidence.recordAssertionEvidence("MySQL workers, writer and rollback preserve consumption", "Competing workers serialize; rollback keeps raw and destination unchanged; all seven requests retain 190 tokens exactly once", true);

    await seed(0, 5, "om_00000000000000000000000002", "model-b");
    await seed(0, 6, "om_00000000000000000000000002", "model-c", false);
    await seed(3, 7, "om_00000000000000000000000002", "model-a");
    for (let i = 0; i < 4; i += 1) expect((await run()).status).toBe(200);
    expect(await rows()).toMatchObject([
      { org_membership_id: "om_00000000000000000000000001", upstream_model: "model-a", input_tokens: 190 },
      { org_membership_id: "om_00000000000000000000000002", upstream_model: "model-a", input_tokens: 3 },
      { org_membership_id: "om_00000000000000000000000002", upstream_model: "model-b", input_tokens: 0, cost_count: 1, cost_micro_usd: 0, latency_count: 1, ttfb_count: 1 },
      { org_membership_id: "om_00000000000000000000000002", upstream_model: "model-c", input_tokens: 0, cost_count: 0, cost_micro_usd: 0, latency_count: 0, ttfb_count: 0 },
    ]);
    expect(await rows()).toHaveLength(4);
    evidence.recordAssertionEvidence("Member/model separation and zero versus missing survive compaction", "Second member's models remain separate; observed free cost/zero latency have count 1, missing observations have count 0", true);
  } finally {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
    }
  }
});
