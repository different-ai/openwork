import { describe, expect, test } from "bun:test";

import {
  attemptSilentMcpReauth,
  isSilentReauthCandidate,
  selectSilentReauthCandidates,
  SILENT_REAUTH_COOLDOWN_MS,
  silentReauthAttemptKey,
} from "../src/react-app/domains/connections/mcp-silent-reauth";
import type { McpServerEntry, McpStatusMap } from "../src/app/types";

const DIR = "/tmp/workspace";

function remoteOauthEntry(name: string, config: Partial<McpServerEntry["config"]> = {}): McpServerEntry {
  return {
    name,
    config: { type: "remote", url: "https://example.com/mcp", ...config },
  };
}

describe("isSilentReauthCandidate", () => {
  test("accepts unhealthy remote oauth entries", () => {
    const entry = remoteOauthEntry("crm");
    expect(isSilentReauthCandidate(entry, { crm: { status: "needs_auth" } })).toBe(true);
    expect(isSilentReauthCandidate(entry, { crm: { status: "failed", error: "Connection closed" } })).toBe(true);
  });

  test("rejects healthy, interactive-only, and non-oauth entries", () => {
    const entry = remoteOauthEntry("crm");
    expect(isSilentReauthCandidate(entry, { crm: { status: "connected" } })).toBe(false);
    expect(isSilentReauthCandidate(entry, { crm: { status: "disabled" } })).toBe(false);
    expect(isSilentReauthCandidate(entry, { crm: { status: "needs_client_registration", error: "register" } })).toBe(false);
    expect(isSilentReauthCandidate(entry, {})).toBe(false);

    const statuses: McpStatusMap = { crm: { status: "needs_auth" } };
    expect(isSilentReauthCandidate(remoteOauthEntry("crm", { oauth: false }), statuses)).toBe(false);
    expect(
      isSilentReauthCandidate(remoteOauthEntry("crm", { headers: { Authorization: "Bearer x" } }), statuses),
    ).toBe(false);
    expect(isSilentReauthCandidate(remoteOauthEntry("crm", { enabled: false }), statuses)).toBe(false);
    expect(
      isSilentReauthCandidate({ name: "crm", config: { type: "local", command: ["mcp"] } }, statuses),
    ).toBe(false);
  });
});

describe("selectSilentReauthCandidates", () => {
  test("applies the cooldown per entry and resets it on recovery", () => {
    const attempts = new Map<string, number>();
    const servers = [remoteOauthEntry("crm")];
    const unhealthy: McpStatusMap = { crm: { status: "needs_auth" } };

    expect(
      selectSilentReauthCandidates({ directory: DIR, servers, statuses: unhealthy, now: 1_000, attempts }),
    ).toEqual(["crm"]);

    attempts.set(silentReauthAttemptKey(DIR, "crm"), 1_000);
    expect(
      selectSilentReauthCandidates({ directory: DIR, servers, statuses: unhealthy, now: 2_000, attempts }),
    ).toEqual([]);
    expect(
      selectSilentReauthCandidates({
        directory: DIR,
        servers,
        statuses: unhealthy,
        now: 1_000 + SILENT_REAUTH_COOLDOWN_MS,
        attempts,
      }),
    ).toEqual(["crm"]);

    // A connected pass clears the cooldown so the next episode retries
    // immediately.
    selectSilentReauthCandidates({
      directory: DIR,
      servers,
      statuses: { crm: { status: "connected" } },
      now: 2_000,
      attempts,
    });
    expect(attempts.has(silentReauthAttemptKey(DIR, "crm"))).toBe(false);
    expect(
      selectSilentReauthCandidates({ directory: DIR, servers, statuses: unhealthy, now: 3_000, attempts }),
    ).toEqual(["crm"]);
  });

  test("scopes cooldowns by directory", () => {
    const attempts = new Map<string, number>([[silentReauthAttemptKey("/other", "crm"), 1_000]]);
    expect(
      selectSilentReauthCandidates({
        directory: DIR,
        servers: [remoteOauthEntry("crm")],
        statuses: { crm: { status: "needs_auth" } },
        now: 1_001,
        attempts,
      }),
    ).toEqual(["crm"]);
  });
});

describe("attemptSilentMcpReauth", () => {
  test("connects each eligible entry once and reports the attempt", async () => {
    const connected: string[] = [];
    const client = {
      mcp: {
        connect: async ({ name }: { name: string; directory?: string }) => {
          connected.push(name);
          return true;
        },
      },
    };
    const attempts = new Map<string, number>();
    const servers = [
      remoteOauthEntry("crm"),
      remoteOauthEntry("header-authed", { headers: { Authorization: "Bearer x" }, oauth: false }),
      remoteOauthEntry("healthy"),
    ];
    const statuses: McpStatusMap = {
      crm: { status: "needs_auth" },
      "header-authed": { status: "needs_auth" },
      healthy: { status: "connected" },
    };

    await expect(
      attemptSilentMcpReauth({ client, directory: DIR, servers, statuses, now: 1_000, attempts }),
    ).resolves.toBe(true);
    expect(connected).toEqual(["crm"]);

    // Second pass inside the cooldown window is a no-op.
    await expect(
      attemptSilentMcpReauth({ client, directory: DIR, servers, statuses, now: 2_000, attempts }),
    ).resolves.toBe(false);
    expect(connected).toEqual(["crm"]);
  });

  test("swallows connect failures and still records the attempt", async () => {
    const client = {
      mcp: {
        connect: async () => {
          throw new Error("engine unavailable");
        },
      },
    };
    const attempts = new Map<string, number>();
    await expect(
      attemptSilentMcpReauth({
        client,
        directory: DIR,
        servers: [remoteOauthEntry("crm")],
        statuses: { crm: { status: "failed", error: "Connection closed" } },
        now: 1_000,
        attempts,
      }),
    ).resolves.toBe(true);
    expect(attempts.get(silentReauthAttemptKey(DIR, "crm"))).toBe(1_000);
  });

  test("returns false for a blank directory", async () => {
    const client = {
      mcp: {
        connect: async () => true,
      },
    };
    await expect(
      attemptSilentMcpReauth({
        client,
        directory: "  ",
        servers: [remoteOauthEntry("crm")],
        statuses: { crm: { status: "needs_auth" } },
        attempts: new Map(),
      }),
    ).resolves.toBe(false);
  });
});
