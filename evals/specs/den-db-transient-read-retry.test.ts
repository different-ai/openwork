import { expect } from "vitest";
import { localMysqlIsRunning, localRedisIsRunning, needs, server, SkipError, test } from "@openwork/testkit";
import { mockPlanetScale } from "@openwork/labs";

test("MCP database read recovery preserves authentication and surfaces persistent failures", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ placement: "local", commands: ["openssl"] });
  if (!await localMysqlIsRunning()) throw new SkipError("MySQL on 127.0.0.1:3306 for isolated Den bootstrap");
  if (!await localRedisIsRunning()) throw new SkipError("Redis on 127.0.0.1:6379");
  await using database = await mockPlanetScale(/from `oauthAccessToken`/);
  await using den = await server({
    place,
    provision: false,
    web: false,
    env: {
      DB_MODE: "planetscale",
      DATABASE_HOST: database.host,
      DATABASE_USERNAME: "synthetic-user",
      DATABASE_PASSWORD: "synthetic-password",
      NODE_EXTRA_CA_CERTS: database.caPath,
      DEN_AUTOMATIONS_ENABLED: "false",
      DEN_AUTOMATIONS_RUNTIME_ENABLED: "false",
    },
  });
  const request = () => fetch(`${den.ref.apiUrl}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: "Bearer ow_mcp_at_synthetic-invalid-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    signal: AbortSignal.timeout(20_000),
  });

  database.respondWith([503, 200]);
  const recovered = await request();
  expect(recovered.status).toBe(401);
  expect(await recovered.json()).toMatchObject({ error: "invalid_mcp_token" });
  expect(database.queries).toHaveLength(2);
  expect(database.queries[0]).toMatch(/^select\b/i);
  expect(database.queries[1]).toBe(database.queries[0]);
  evidence.recordAssertionEvidence("A transient read recovers without granting access", "POST /mcp/agent reached the real Den/Drizzle/PlanetScale path: synthetic HTTP 503 then 200 produced exactly two identical SELECT requests and the correct invalid-token 401, never a successful tool response.", true);

  database.respondWith([503, 503]);
  const unavailable = await request();
  expect(unavailable.status).toBe(500);
  expect(unavailable.headers.get("www-authenticate")).toBeNull();
  expect(database.queries).toHaveLength(2);
  evidence.recordAssertionEvidence("Retry exhaustion remains an infrastructure failure", "Two synthetic database 503 responses produced HTTP 500 after exactly two attempts, without an authentication challenge or a disconnected result.", true);

  database.respondWith([403]);
  const forbidden = await request();
  expect(forbidden.status).toBe(500);
  expect(database.queries).toHaveLength(1);
  evidence.recordAssertionEvidence("Database authorization errors are never retried or converted to missing credentials", "A synthetic provider 403 remained HTTP 500 after one database request.", true);

  database.respondWith([503], /^insert into `user`/i);
  const signup = await fetch(`${den.ref.apiUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: den.ref.webUrl },
    body: JSON.stringify({ name: "Synthetic retry proof", email: "retry-proof@example.test", password: "Synthetic-proof-password-27!" }),
    signal: AbortSignal.timeout(20_000),
  });
  expect(signup.ok).toBe(false);
  expect(signup.status).toBeGreaterThanOrEqual(400);
  expect(database.queries).toHaveLength(1);
  expect(database.queries[0]).toMatch(/^insert into `user`/i);
  evidence.recordAssertionEvidence("A failed signup write is never replayed", "A synthetic signup reached the real user INSERT and received a database 503; the API rejected the signup after exactly one INSERT attempt, so an uncertain write was not replayed.", true);
});
