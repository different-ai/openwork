import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const HOST_TOKEN = "owt_env_host_token";
const stops: Array<() => void | Promise<void>> = [];
const dirs: string[] = [];
const priorEnvStore = process.env.OPENWORK_ENV_STORE;
const priorTokenStore = process.env.OPENWORK_TOKEN_STORE;

function baseConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_env_client_token",
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  } as ServerConfig;
}

function boot() {
  const server = startServer(baseConfig()) as Served;
  stops.push(() => server.stop(true));
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
  };
}

function hostAuth() {
  return { "x-openwork-host-token": HOST_TOKEN, "content-type": "application/json" };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "openwork-env-routes-"));
  dirs.push(dir);
  // Redirect the shared env.json path into a throwaway dir so the test never
  // touches the developer's real ~/.config/openwork/env.json.
  process.env.OPENWORK_ENV_STORE = join(dir, "env.json");
  process.env.OPENWORK_TOKEN_STORE = join(dir, "tokens.json");
});

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
  if (priorEnvStore === undefined) {
    delete process.env.OPENWORK_ENV_STORE;
  } else {
    process.env.OPENWORK_ENV_STORE = priorEnvStore;
  }
  if (priorTokenStore === undefined) {
    delete process.env.OPENWORK_TOKEN_STORE;
  } else {
    process.env.OPENWORK_TOKEN_STORE = priorTokenStore;
  }
});

describe("env routes", () => {
  test("rejects unauthenticated requests", async () => {
    const { base } = boot();
    const response = await fetch(`${base}/env`);
    expect(response.status).toBe(401);
  });

  test("rejects owner bearer tokens", async () => {
    const { base } = boot();
    const issued = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify({ scope: "owner", label: "test owner" }),
    });
    expect(issued.status).toBe(201);
    const body = (await issued.json()) as { token: string };

    const response = await fetch(`${base}/env`, {
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(response.status).toBe(401);
  });

  test("CORS preflight allows PUT", async () => {
    const { base } = boot();
    const response = await fetch(`${base}/env`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PUT",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  test("PUT + GET round-trips a single entry and returns raw values", async () => {
    const { base } = boot();
    const put = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ key: "ANTHROPIC_API_KEY", value: "sk-ant-abc" }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true, count: 1 });

    const list = await fetch(`${base}/env`, { headers: hostAuth() });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Array<{ key: string; value: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ key: "ANTHROPIC_API_KEY", value: "sk-ant-abc" });
  });

  test("GET /env/keys returns names without values", async () => {
    const { base } = boot();
    await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({
        entries: [
          { key: "ANTHROPIC_API_KEY", value: "sk-ant-abc" },
          { key: "NBA_LIVE_KEY", value: "secret-value" },
        ],
      }),
    });

    const list = await fetch(`${base}/env/keys`, { headers: hostAuth() });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ keys: ["ANTHROPIC_API_KEY", "NBA_LIVE_KEY"] });
  });

  test("invalid env store returns 409 instead of overwriting on PUT", async () => {
    writeFileSync(process.env.OPENWORK_ENV_STORE!, "{ this is not json");
    const { base } = boot();

    const put = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ key: "SAFE", value: "new" }),
    });

    expect(put.status).toBe(409);
    const body = (await put.json()) as { code: string; message: string };
    expect(body.code).toBe("invalid_env_store");
  });

  test("PUT accepts a batch via entries[]", async () => {
    const { base } = boot();
    const put = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({
        entries: [
          { key: "A", value: "1" },
          { key: "B", value: "2" },
        ],
      }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true, count: 2 });

    const body = (await (await fetch(`${base}/env`, { headers: hostAuth() })).json()) as {
      items: Array<{ key: string }>;
    };
    expect(body.items.map((i) => i.key)).toEqual(["A", "B"]);
  });

  test("PUT rejects invalid keys with 400", async () => {
    const { base } = boot();
    const put = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ key: "bad-key", value: "x" }),
    });
    expect(put.status).toBe(400);
    const body = (await put.json()) as { code: string; message: string };
    expect(body.code).toBe("invalid_env_key");
    expect(body.message).toBe("Invalid environment variable name");
    expect(body.message).not.toContain("bad-key");
  });

  test("PUT rejects reserved keys with 400", async () => {
    const { base } = boot();
    const put = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ key: "OPENWORK_TOKEN", value: "x" }),
    });
    expect(put.status).toBe(400);
    const body = (await put.json()) as { code: string; message: string };
    expect(body.code).toBe("reserved_env_key");
    expect(body.message).toBe("Environment variable name is reserved for OpenWork internals");
    expect(body.message).not.toContain("OPENWORK_TOKEN");
  });

  test("PUT with no entries returns 400", async () => {
    const { base } = boot();
    const put = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ entries: [] }),
    });
    expect(put.status).toBe(400);
  });

  test("DELETE removes an existing entry", async () => {
    const { base } = boot();
    await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ key: "FOO", value: "bar" }),
    });

    const del = await fetch(`${base}/env/FOO`, { method: "DELETE", headers: hostAuth() });
    expect(del.status).toBe(200);

    const list = (await (await fetch(`${base}/env`, { headers: hostAuth() })).json()) as {
      items: unknown[];
    };
    expect(list.items).toHaveLength(0);
  });

  test("DELETE on missing key returns 404", async () => {
    const { base } = boot();
    const del = await fetch(`${base}/env/MISSING`, { method: "DELETE", headers: hostAuth() });
    expect(del.status).toBe(404);
  });

  test("values persist across server restart", async () => {
    const first = boot();
    await fetch(`${first.base}/env`, {
      method: "PUT",
      headers: hostAuth(),
      body: JSON.stringify({ key: "PERSISTED", value: "yes" }),
    });
    await first.server.stop(true);
    stops.pop();

    const second = boot();
    const body = (await (await fetch(`${second.base}/env`, { headers: hostAuth() })).json()) as {
      items: Array<{ key: string; value: string }>;
    };
    expect(body.items).toEqual([expect.objectContaining({ key: "PERSISTED", value: "yes" })]);
  });
});
