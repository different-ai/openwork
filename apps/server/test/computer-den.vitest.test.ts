import { expect, test, vi } from "vitest";
import { createComputersDen } from "../src/computers/den.js";
import type { CloudProviderDenSession } from "../src/cloud-provider-sync.js";

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
