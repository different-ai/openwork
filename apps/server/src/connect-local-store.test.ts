import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";
import { ConnectLocalStore } from "./connect-local-store.js";
import { ConnectLocalVault } from "./connect-local-vault.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openwork-connect-store-"));
  roots.push(root);
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "client",
    hostToken: "host",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "json",
    logRequests: false,
  };
  const env = { ...process.env, OPENWORK_CONNECT_VAULT_KEY: randomBytes(32).toString("base64url") };
  const vault = new ConnectLocalVault(env);
  return {
    root,
    config,
    vault,
    store: new ConnectLocalStore(config, vault),
  };
}

test("local OAuth state is signed, expiring, and bound to its connection and callback", async () => {
  const { vault } = await fixture();
  const input = {
    connectionId: "cn_one",
    redirectUri: "http://127.0.0.1:3000/v1/connect/connections/cn_one/callback",
    now: 1_000,
    ttlMs: 5_000,
  };
  const candidate = vault.createAuthorizationId(input);

  expect(vault.verifiesAuthorizationId({ ...input, candidate, now: 2_000 })).toBe(true);
  expect(vault.verifiesAuthorizationId({ ...input, candidate, connectionId: "cn_two", now: 2_000 })).toBe(false);
  expect(vault.verifiesAuthorizationId({ ...input, candidate, redirectUri: "http://127.0.0.1:3001/callback", now: 2_000 })).toBe(false);
  expect(vault.verifiesAuthorizationId({ ...input, candidate: `${candidate}x`, now: 2_000 })).toBe(false);
  expect(vault.verifiesAuthorizationId({ ...input, candidate, now: 6_001 })).toBe(false);
});

test("changing Connect mode rotates the dedicated agent credential", async () => {
  const { store, vault } = await fixture();
  const firstRevision = store.agentRevision();
  const firstToken = vault.agentToken(firstRevision);
  store.setMode("local");
  const nextRevision = store.agentRevision();

  expect(nextRevision).not.toBe(firstRevision);
  expect(vault.verifiesAgentToken(firstToken, nextRevision)).toBe(false);
  expect(vault.verifiesAgentToken(vault.agentToken(nextRevision), nextRevision)).toBe(true);
});

test("dynamic OAuth clients are rebound when the callback origin changes", async () => {
  const { store } = await fixture();
  const connection = store.createConnection({
    name: "Dynamic OAuth MCP",
    serverUrl: "https://mcp.example.com",
    authType: "oauth",
  });
  const controller = new AbortController();
  const context = {
    connectionId: connection.id,
    commitExpiresAt: Date.now() + 60_000,
    signal: controller.signal,
  };
  const first = store.oauthPersistence(connection.id, "http://127.0.0.1:3000/callback");
  await first.clientRegistrations.save({
    context,
    clientInformation: { client_id: "dynamic-client" },
    source: "dynamic",
  });

  expect((await first.clientRegistrations.load(context))?.clientInformation.client_id).toBe("dynamic-client");
  const moved = store.oauthPersistence(connection.id, "http://127.0.0.1:3001/callback");
  expect(await moved.clientRegistrations.load(context)).toBeUndefined();
});

test("local Connect OAuth persistence encrypts tokens and atomically consumes PKCE state", async () => {
  const { root, config, store } = await fixture();
  const connection = store.createConnection({
    name: "OAuth MCP",
    serverUrl: "https://mcp.example.com",
    authType: "oauth",
  });
  const persistence = store.oauthPersistence(connection.id, "http://127.0.0.1:3000/v1/connect/connections/callback");
  const controller = new AbortController();
  const context = {
    connectionId: connection.id,
    commitExpiresAt: Date.now() + 60_000,
    signal: controller.signal,
  };

  await persistence.authorizations.begin({
    context,
    id: "state-secret",
    codeVerifier: "verifier-secret",
    expiresAt: Date.now() + 30_000,
  });
  const pending = await persistence.authorizations.load({ context, id: "state-secret" });
  expect(pending?.codeVerifier).toBe("verifier-secret");
  expect(pending?.handle.id).toBe("state-secret");

  await persistence.credentials.save({
    context,
    tokens: { access_token: "access-secret", token_type: "Bearer" },
    source: "authorization-code",
    authorization: pending?.handle,
  });

  expect(await persistence.authorizations.load({ context, id: "state-secret" })).toBeUndefined();
  expect((await persistence.credentials.load(context))?.tokens.access_token).toBe("access-secret");

  const database = await readFile(join(root, "runtime.sqlite"));
  const wal = await readFile(join(root, "runtime.sqlite-wal")).catch(() => Buffer.alloc(0));
  const serialized = Buffer.concat([database, wal]).toString("latin1");
  expect(serialized).not.toContain("access-secret");
  expect(serialized).not.toContain("verifier-secret");
  expect(serialized).not.toContain("state-secret");
  expect(await readFile(config.configPath ?? "", "utf8").catch(() => "")).not.toContain("access-secret");
});
