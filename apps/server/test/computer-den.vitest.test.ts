import { expect, test, vi } from "vitest";
import { createComputersDen } from "../src/computers/den.js";
import type { CloudProviderDenSession } from "../src/cloud-provider-sync.js";
import type { RunnerCredential } from "../src/computers/runner-credential.js";
import type { ComputerToolCall } from "@openwork/types/den/computers";

test("uses the actual runner identity for listing, authorizing, enqueueing and following, without leaking it to member endpoints", async () => {
  const member = { baseUrl: "https://member.example.test", orgId: "fixture-org", token: "member-token" };
  const device = { baseUrl: "https://runner.example.test", token: "runner-token" };
  let runner: RunnerCredential | null = null;
  const requests: { url: string; method?: string; authorization: string | null; org: string | null; body?: unknown }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ url, method: init?.method, authorization: headers.get("Authorization"), org: headers.get("x-openwork-org-id"), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/authorize")) return Response.json({ error: "computer_not_found" }, { status: 404 });
    if (url.includes("/commands")) return Response.json({ state: "running", id: "id", expiresAt: "2026-11-26T18:00:00Z" });
    return Response.json(runner ? { self: null, computers: [] } : { computers: [] });
  };
  const den = createComputersDen(() => member, { runnerCredential: () => runner, fetch });
  const signal = new AbortController().signal;
  const action = { type: "shell", command: "pwd" } satisfies Parameters<typeof den.authorize>[1];
  const call: ComputerToolCall = { tool: "shell", input: { command: "pwd", cwd: "/workspace" } };
  expect(den.sourceQueue()).toBeNull();
  expect(await den.listComputers()).toMatchObject({ status: "enabled", computers: [] });
  await expect(den.authorize("id", action, signal)).rejects.toThrow("no longer available");
  runner = device;
  expect(await den.listComputers()).toEqual({ status: "enabled", self: null, computers: [] });
  await expect(den.authorize("id", action, signal)).rejects.toThrow("no longer available");
  const queue = den.sourceQueue();
  expect(await queue?.enqueue("other/id", call, signal)).toMatchObject({ state: "running" });
  expect(await queue?.follow("id", signal)).toMatchObject({ state: "running" });
  runner = null;
  await expect(queue?.follow("id", signal)).rejects.toThrow("couldn't check access");
  expect(requests).toEqual([
    { url: `${member.baseUrl}/v1/computers`, method: "GET", authorization: "Bearer member-token", org: "fixture-org" },
    { url: `${member.baseUrl}/v1/computers/id/authorize`, method: "POST", authorization: "Bearer member-token", org: "fixture-org", body: { action } },
    { url: `${device.baseUrl}/v1/computer-sources/computers`, method: "GET", authorization: "Bearer runner-token", org: null },
    { url: `${device.baseUrl}/v1/computer-sources/computers/id/authorize`, method: "POST", authorization: "Bearer runner-token", org: null, body: { action } },
    { url: `${device.baseUrl}/v1/computer-sources/computers/other%2Fid/commands`, method: "POST", authorization: "Bearer runner-token", org: null, body: { call, waitMs: 15_000 } },
    { url: `${device.baseUrl}/v1/computer-sources/commands/id?waitMs=15000`, method: "GET", authorization: "Bearer runner-token", org: null },
  ]);
});

function fixture() {
  let clock = 0;
  let enabled = false;
  let session: CloudProviderDenSession | null = { baseUrl: "https://den.example.test", orgId: "test-org", token: "token" };
  const fetch = vi.fn(async () => enabled ? Response.json({ computers: [] }) : Response.json({ error: "feature_disabled" }, { status: 404 }));
  return {
    den: createComputersDen(() => session, { now: () => clock, fetch }), fetch,
    advance(ms: number) { clock += ms; },
    enable(value: boolean) { enabled = value; },
    session(value: CloudProviderDenSession | null) { session = value; },
  };
}

test("coalesces status probes and caches off for five minutes and enabled for thirty seconds", async () => {
  const f = fixture();
  expect(await Promise.all([f.den.status(), f.den.status()])).toEqual(["off", "off"]);
  f.enable(true);
  f.advance(299_999);
  expect(await f.den.status()).toBe("off");
  expect(f.fetch).toHaveBeenCalledTimes(1);
  f.advance(1);
  expect(await f.den.status()).toBe("enabled");
  f.enable(false);
  f.advance(29_999);
  expect(await f.den.status()).toBe("enabled");
  expect(f.fetch).toHaveBeenCalledTimes(2);
  f.advance(1);
  expect(await f.den.status()).toBe("off");
  expect(f.fetch).toHaveBeenCalledTimes(3);
});

test("an authorize feature-disabled answer immediately invalidates the enabled status", async () => {
  const f = fixture();
  f.enable(true);
  expect(await f.den.status()).toBe("enabled");
  f.enable(false);
  await expect(f.den.authorize("vm", { type: "shell", command: "pwd" }, new AbortController().signal)).rejects.toThrow("is turned off");
  expect(await f.den.status()).toBe("off");
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

test("status is scoped to the Den identity, and failures are not cached as feature off", async () => {
  const f = fixture();
  expect(await f.den.status()).toBe("off");
  f.session(null);
  expect(await f.den.status()).toBe("off");
  expect(f.fetch).toHaveBeenCalledTimes(1);
  f.session({ baseUrl: "https://den.example.test", orgId: "another-org", token: "token" });
  f.fetch.mockRejectedValueOnce(new Error("disconnected"));
  expect(await f.den.status()).toBe("unavailable");
  f.enable(true);
  expect(await f.den.status()).toBe("enabled");
  expect(f.fetch).toHaveBeenCalledTimes(3);
});
