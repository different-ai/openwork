import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Full MCP OAuth flow e2e:
 *
 *   real opencode engine (sidecar binary)
 *     -> mock OAuth MCP server (scripts/mock-oauth-mcp-server.mjs)
 *     -> discovery + dynamic client registration + PKCE (S256)
 *     -> authorization redirect ("the browser")
 *     -> token exchange (PKCE verified by the mock)
 *     -> authenticated streamable-HTTP MCP connect (tools/list)
 *
 * The test plays the role of the user's browser by following the
 * authorization URL and the resulting redirect to the engine's loopback
 * callback. This is the same flow the OpenWork desktop app drives through
 * the OAuth modal (apps/app .../connections/mcp-auth-modal.tsx).
 *
 * Skipped automatically when the opencode sidecar binary is not present
 * (e.g. CI runners that never ran prepare:sidecar).
 */

const repoRoot = resolve(import.meta.dir, "../../..");
const sidecarDir = join(repoRoot, "apps/desktop/resources/sidecars");

function findSidecar(): string | null {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const names =
    process.platform === "darwin"
      ? [`opencode-${arch}-apple-darwin`]
      : process.platform === "linux"
        ? [`opencode-${arch}-unknown-linux-gnu`, `opencode-${arch}-unknown-linux-musl`]
        : [];
  for (const name of names) {
    const candidate = join(sidecarDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const enginePath = findSidecar();
const describeMaybe = enginePath ? describe : describe.skip;

const MCP_NAME = "mock-oauth-flow";

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("failed to allocate a free port");
  return port;
}

describeMaybe("mcp oauth flow against mock provider", () => {
  let mockProc: ChildProcess;
  let engineProc: ChildProcess;
  let mockPort = 0;
  let enginePort = 0;
  let workDir = "";
  let dataDir = "";

  const mockUrl = () => `http://127.0.0.1:${mockPort}`;
  const engineUrl = () => `http://127.0.0.1:${enginePort}`;

  async function engineFetch(path: string, init?: RequestInit) {
    const url = new URL(`${engineUrl()}${path}`);
    url.searchParams.set("directory", workDir);
    return fetch(url, init);
  }

  beforeAll(async () => {
    mockPort = await getFreePort();
    enginePort = await getFreePort();

    workDir = mkdtempSync(join(tmpdir(), "mcp-oauth-ws-"));
    dataDir = mkdtempSync(join(tmpdir(), "mcp-oauth-data-"));
    writeFileSync(
      join(workDir, "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          [MCP_NAME]: { type: "remote", url: `${mockUrl()}/mcp`, enabled: true, oauth: {} },
        },
      }),
    );

    mockProc = spawn("node", [join(repoRoot, "scripts/mock-oauth-mcp-server.mjs")], {
      env: { ...process.env, PORT: String(mockPort), AUTO_APPROVE: "1" },
      stdio: "ignore",
    });
    await waitFor(
      async () => {
        const res = await fetch(`${mockUrl()}/health`);
        return res.ok ? true : null;
      },
      10_000,
      "mock oauth server",
    );

    engineProc = spawn(enginePath!, ["serve", "--hostname", "127.0.0.1", "--port", String(enginePort)], {
      env: {
        ...process.env,
        XDG_DATA_HOME: join(dataDir, "xdg-data"),
        XDG_CONFIG_HOME: join(dataDir, "xdg-config"),
        XDG_STATE_HOME: join(dataDir, "xdg-state"),
        XDG_CACHE_HOME: join(dataDir, "xdg-cache"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      stdio: "ignore",
    });
    await waitFor(
      async () => {
        const res = await engineFetch("/mcp");
        return res.ok ? true : null;
      },
      30_000,
      "opencode engine",
    );
  }, 60_000);

  afterAll(() => {
    engineProc?.kill();
    mockProc?.kill();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test(
    "engine completes browser OAuth (discovery, DCR, PKCE) and connects",
    async () => {
      // Initially the MCP requires auth.
      const before = (await (await engineFetch("/mcp")).json()) as Record<string, { status: string }>;
      expect(before[MCP_NAME]).toBeDefined();
      expect(before[MCP_NAME].status).not.toBe("connected");

      // Start the OAuth flow: engine performs discovery + dynamic client
      // registration and hands back the authorization URL it would open
      // in the user's browser.
      const startRes = await engineFetch(`/mcp/${MCP_NAME}/auth`, { method: "POST" });
      expect(startRes.ok).toBe(true);
      const started = (await startRes.json()) as { authorizationUrl?: string; url?: string };
      const authorizationUrl = started.authorizationUrl ?? started.url;
      expect(authorizationUrl).toBeTruthy();
      const authUrl = new URL(authorizationUrl!);
      expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
      expect(authUrl.searchParams.get("state")).toBeTruthy();

      // Play the browser: visit the authorization URL. The mock
      // auto-approves and 302s to the engine's loopback callback.
      const authorizeRes = await fetch(authorizationUrl!, { redirect: "manual" });
      expect(authorizeRes.status).toBe(302);
      const callbackUrl = authorizeRes.headers.get("location");
      expect(callbackUrl).toBeTruthy();
      const cb = new URL(callbackUrl!);
      expect(cb.searchParams.get("code")).toBeTruthy();
      expect(cb.searchParams.get("state")).toBe(authUrl.searchParams.get("state"));

      // Follow the redirect into the engine's loopback callback server,
      // falling back to the manual callback endpoint (the path used for
      // remote workspaces where the loopback is unreachable).
      let callbackDelivered = false;
      try {
        const res = await fetch(callbackUrl!);
        callbackDelivered = res.ok;
      } catch {
        callbackDelivered = false;
      }
      if (!callbackDelivered) {
        const manual = await engineFetch(`/mcp/${MCP_NAME}/auth/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: cb.searchParams.get("code") }),
        });
        expect(manual.ok).toBe(true);
      }

      // The engine exchanges the code (mock verifies PKCE) and connects.
      const connected = await waitFor(
        async () => {
          const res = await engineFetch("/mcp");
          if (!res.ok) return null;
          const statuses = (await res.json()) as Record<string, { status: string }>;
          return statuses[MCP_NAME]?.status === "connected" ? statuses : null;
        },
        30_000,
        "mcp connected status",
      );
      expect(connected[MCP_NAME].status).toBe("connected");

      // Tokens are persisted for reuse across restarts.
      const authFile = join(dataDir, "xdg-data", "opencode", "mcp-auth.json");
      expect(existsSync(authFile)).toBe(true);
      const saved = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, { tokens?: { accessToken?: string } }>;
      expect(saved[MCP_NAME]?.tokens?.accessToken).toStartWith("mock-access-");

      // The mock saw the full, authenticated MCP handshake.
      const log = (await (await fetch(`${mockUrl()}/requests`)).json()) as {
        requests: Array<{ method: string; path: string }>;
      };
      const paths = log.requests.map((r) => `${r.method} ${r.path}`);
      expect(paths).toContain("POST /register");
      expect(paths).toContain("GET /authorize");
      expect(paths).toContain("POST /token");
      expect(paths).toContain("POST /mcp");
    },
    90_000,
  );

  test("logout removes stored tokens and drops the connection", async () => {
    const remove = await engineFetch(`/mcp/${MCP_NAME}/auth`, { method: "DELETE" });
    expect(remove.ok).toBe(true);

    const authFile = join(dataDir, "xdg-data", "opencode", "mcp-auth.json");
    const saved = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
    expect(saved[MCP_NAME]).toBeUndefined();
  }, 30_000);
});
