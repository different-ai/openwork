import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createConnection } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import type { Place } from "./place.ts";
import { SkipError } from "./needs.ts";
import { DEFAULT_MYSQL_URL, ephemeralDatabaseName, localMysqlIsRunning } from "./place.ts";
import { runDbPush } from "./den.ts";
import { record } from "./free-inference-service.ts";
import type { UpstreamCall, UpstreamPlan } from "./free-inference-service.ts";

export const freeModel = "openai/gpt-5.6-luna";
export const freeCredential = "fixture-free-upstream-not-a-real-key";
const webhookSecret = "fixture-webhook-not-a-real-secret";
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const id = (prefix: string) => `${prefix}_0${randomBytes(13).toString("hex").slice(0, 25)}`;

export interface MemberKey { userId: string; orgId: string; memberId: string; keyId: string; key: string }
interface Bucket extends RowDataPacket {
  user_id: string; window_start_at: Date; window_end_at: Date;
  limit_amount: number; used_amount: number; reserved_amount: number; blocked: number;
}
interface Reservation extends RowDataPacket {
  request_id: string; user_id: string; window_start_at: Date;
  organization_id: string; org_membership_id: string; inference_key_id: string;
  model_id: string; upstream_model: string; max_output_tokens: number;
  reserved_amount: number; actual_amount: number | null; external_event_id: string | null;
  status: "held" | "settled" | "invalid";
}

/** Real app + real schema, isolated DB only. No Den, Redis, provider secrets or UI. */
export async function freeInferenceWorld(stack: AsyncDisposableStack, place: Place) {
  if (place.kind !== "local") throw new SkipError("free inference fixture requires local MySQL; no remote fallback is implemented");
  const mysql = new URL(process.env.OPENWORK_EVAL_MYSQL_URL?.trim() || DEFAULT_MYSQL_URL);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(mysql.hostname)) throw new Error("Free inference proof refuses non-loopback MySQL");
  if (!await localMysqlIsRunning()) throw new SkipError("local MySQL; run pnpm dev:den:mysql");
  const database = stack.use(await place.db(ephemeralDatabaseName("free_inference")));
  await runDbPush(database.url);
  const sql = await createConnection({ uri: database.url, timezone: "Z" });
  stack.defer(() => sql.end());
  await sql.query("SET time_zone = '+00:00'");

  const child = spawn(process.execPath, [
    "--conditions=development", "--import", `${root}/ee/apps/inference/node_modules/tsx/dist/loader.mjs`,
    `${root}/evals/packages/env/src/free-inference-service.ts`,
  ], {
    cwd: root,
    // Do not inherit credentials, Node preload hooks or production DB settings.
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TZ: "UTC", NODE_ENV: "test",
      DATABASE_URL: database.url, DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "fixture-db-encryption-placeholder-1234567890",
      INFERENCE_FREE_ENABLED: "true", INFERENCE_FREE_WEEKLY_BUDGET_USD: "1",
      INFERENCE_FREE_MODEL_ID: freeModel, INFERENCE_FREE_UPSTREAM_API_KEY: freeCredential,
      INFERENCE_WEBHOOK_SECRET: webhookSecret, INFERENCE_ADMIN_TOKEN: "fixture-admin",
      OPENAI_API_KEY: "", OPENAI_REALTIME_API_KEY: "", SENTRY_DSN: "", SENTRY_LOG_LEVEL: "off",
      OPENROUTER_UPSTREAM_URL: "https://openrouter.ai/api/v1", OPENWORK_DEV_MODE: "0",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => { log = (log + chunk.toString()).slice(-8_000); });
  child.stderr?.on("data", (chunk: Buffer) => { log = (log + chunk.toString()).slice(-8_000); });
  stack.defer(async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try { await exited; } finally { clearTimeout(timer); }
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Inference fixture did not boot: ${log}`)), 30_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Inference fixture exited (${code}): ${log}`)); });
    child.once("message", (message) => {
      clearTimeout(timer);
      const value = record(message).url;
      if (typeof value === "string") resolve(value);
      else reject(new Error("Invalid inference fixture address"));
    });
  });
  const http = (path: string, init?: RequestInit) => fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(25_000) });
  const ready = await http("/ready");
  if (!ready.ok) throw new Error(`Inference database readiness failed: ${await ready.text()} ${log}`);
  const control = async (path: string, body: unknown) => {
    const result = await http(`/__fixture/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!result.ok) throw new Error(`Fixture control failed: ${path} ${result.status}`);
  };
  const orgs = [id("org"), id("org")];
  for (const org of orgs) {
    await sql.execute("INSERT INTO organization (id, name, slug, metadata) VALUES (?, ?, ?, ?)",
      [org, "Allowance fixture", org, JSON.stringify({ inferenceFree: { offerAllowed: true } })]);
  }

  return {
    url, database, http,
    plan: (prompt: string, plan: UpstreamPlan) => control("plan", { prompt, ...plan }),
    release: (prompt: string) => control("release", { prompt }),
    async calls(): Promise<UpstreamCall[]> {
      const response = await http("/__fixture/upstream");
      if (!response.ok) throw new Error("Cannot read upstream witness");
      return response.json();
    },
    async seedPerson(): Promise<[MemberKey, MemberKey, MemberKey]> {
      const userId = id("usr");
      await sql.execute("INSERT INTO `user` (id, name, email, email_verified) VALUES (?, ?, ?, true)", [userId, "Allowance person", `${userId}@openwork.test`]);
      const members: MemberKey[] = [];
      for (const orgId of orgs) {
        const memberId = id("om");
        await sql.execute("INSERT INTO member (id, organization_id, user_id) VALUES (?, ?, ?)", [memberId, orgId, userId]);
        for (let i = 0; i < (orgId === orgs[0] ? 2 : 1); i++) {
          const keyId = id("ink"), key = `ow_inf_${randomBytes(32).toString("base64url")}`;
          await sql.execute("INSERT INTO inference_keys (id, organization_id, org_membership_id, key_hash, status) VALUES (?, ?, ?, ?, 'active')",
            [keyId, orgId, memberId, createHash("sha256").update(key).digest("hex")]);
          members.push({ userId, orgId, memberId, keyId, key });
        }
      }
      const [a, b, c] = members;
      if (!a || !b || !c) throw new Error("Missing fixture keys");
      return [a, b, c];
    },
    async snapshot(userId: string) {
      const [buckets] = await sql.execute<Bucket[]>("SELECT * FROM inference_free_usage_buckets WHERE user_id = ? ORDER BY window_start_at", [userId]);
      const [reservations] = await sql.execute<Reservation[]>("SELECT * FROM inference_free_reservations WHERE user_id = ? ORDER BY created_at, request_id", [userId]);
      const [paid] = await sql.query<RowDataPacket[]>("SELECT (SELECT COUNT(*) FROM inference_org_usage_buckets) AS buckets, (SELECT COUNT(*) FROM inference_usage_ledger_entries) AS ledger");
      return { buckets, reservations, paid };
    },
    // Explicit rollover arrangement: move only this person's existing history,
    // atomically, not the SQL server's shared clock or any accounting function.
    async seedPreviousWeek(userId: string) {
      await sql.beginTransaction();
      try {
        await sql.execute("UPDATE inference_free_usage_buckets SET window_start_at = DATE_SUB(window_start_at, INTERVAL 7 DAY), window_end_at = DATE_SUB(window_end_at, INTERVAL 7 DAY) WHERE user_id = ?", [userId]);
        await sql.execute("UPDATE inference_free_reservations SET window_start_at = DATE_SUB(window_start_at, INTERVAL 7 DAY) WHERE user_id = ?", [userId]);
        await sql.commit();
      } catch (error) { await sql.rollback(); throw error; }
    },
    async seedRevokedKey(keyId: string) {
      await sql.execute("UPDATE inference_keys SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [keyId]);
    },
    webhook(call: UpstreamCall, cost: number, overrides: Record<string, string | number> = {}, signature = webhookSecret) {
      const trace = record(call.body.trace);
      const attrs = {
        "trace.metadata.openwork_request_id": call.requestId,
        "trace.metadata.inference_key_id": trace.inference_key_id,
        "trace.metadata.org_membership_id": trace.org_membership_id,
        "gen_ai.request.model": call.body.model, "gen_ai.response.model": call.body.model,
        "gen_ai.response.id": call.generationId, "gen_ai.usage.input_cost": 0,
        "gen_ai.usage.output_cost": cost, "gen_ai.usage.currency": "USD", ...overrides,
      };
      return http("/webhooks/openrouter", {
        method: "POST", headers: { "content-type": "application/json", "x-webhook-signature": signature },
        body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{
          attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: typeof value === "number" ? { doubleValue: value } : { stringValue: value } })),
        }] }] }] }),
      });
    },
  };
}
