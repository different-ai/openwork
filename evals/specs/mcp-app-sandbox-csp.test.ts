import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { bootServer, stopChild } from "../worlds/openwork-server-cli.ts";

// The sandbox proxy builds its CSP from the `csp` query param, which the
// embedding page controls. It must apply the same origin rules as the MCP App
// resource meta, so the param can never widen the policy: https: anywhere,
// wss: for connect-src, http: and ws: only on loopback.
const test = spec.world(async (seed) => {
  const root = seed.tmpPath("mcp-app-sandbox-csp");
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENWORK_") && !key.startsWith("OPENCODE")));
  const booted = bootServer({ ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"), OPENWORK_MANAGE_OPENCODE: "0",
  }, "fixture-server-token", workspace, () => {});
  const dispose = async () => {
    await stopChild(booted.child);
    await rm(root, { recursive: true, force: true });
  };
  try {
    const base = await booted.listening;
    return {
      async policy(csp: Record<string, string[]>) {
        const url = new URL(`${base}/mcp-apps/sandbox.html`);
        url.searchParams.set("csp", JSON.stringify(csp));
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        expect(response.status).toBe(200);
        const header = response.headers.get("content-security-policy") ?? "";
        return Object.fromEntries(header.split(";").map((part) => {
          const [name = "", ...sources] = part.trim().split(/\s+/);
          return [name, sources];
        }));
      },
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) { await dispose(); throw error; }
}, { resources: { surfaces: [], services: [] }, needs: { commands: ["bun"] }, timeout: 120_000 });

test("MCP App sandbox csp param keeps https, wss and loopback origins and drops non-loopback http and ws", async ({ world, evidence }) => {
  const policy = await world.policy({
    connectDomains: [
      "https://api.example.com",
      "wss://realtime.example.com",
      "http://localhost:3000",
      "ws://localhost:3000",
      "ws://127.0.0.1:8080",
      "ws://[::1]:8080",
      "ws://example.com",
      "http://example.com",
      "ws://10.0.0.5:8080",
    ],
    resourceDomains: ["https://cdn.example.com", "http://127.0.0.1:5173", "http://cdn.example.com", "wss://cdn.example.com"],
    frameDomains: ["https://frame.example.com", "http://frame.example.com"],
    baseUriDomains: ["https://base.example.com", "http://base.example.com"],
  });
  expect(policy["connect-src"]).toEqual([
    "https://api.example.com",
    "wss://realtime.example.com",
    "http://localhost:3000",
    "ws://localhost:3000",
    "ws://127.0.0.1:8080",
    "ws://[::1]:8080",
  ]);
  expect(policy["script-src"]).toEqual(["'self'", "'unsafe-inline'", "https://cdn.example.com", "http://127.0.0.1:5173"]);
  expect(policy["frame-src"]).toEqual(["'self'", "https://frame.example.com"]);
  expect(policy["base-uri"]).toEqual(["https://base.example.com"]);
  const header = JSON.stringify(policy);
  for (const dropped of ["ws://example.com", "http://example.com", "ws://10.0.0.5:8080", "http://cdn.example.com", "wss://cdn.example.com", "http://frame.example.com", "http://base.example.com"]) {
    expect(header).not.toContain(`"${dropped}"`);
  }
  evidence.recordAssertionEvidence(
    "Sandbox csp param cannot widen the policy",
    `GET /mcp-apps/sandbox.html kept https, wss and loopback http/ws origins and dropped non-loopback http and ws origins: ${JSON.stringify(policy)}`,
    true,
  );
});
