import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  DESKTOP_FREE_CHAT_PATH, DESKTOP_FREE_SESSION_PATH, MEMBER_FREE_STATUS_PATH, clampSessionPowParams, compareDesktopVersions,
  desktopFreeProofMessage, desktopFreeReleaseTagMessage, desktopFreeVersionError, isDesktopFreeSignableRoute, leadingZeroBits,
  lowestDesktopVersion, parseDesktopReleases, supportedDesktopReleases,
} from "../src/index.js";
import { freeRequestReservation, freeUsageAmount, parseInstallRamp, rampedDeviceAmount, DEFAULT_INSTALL_RAMP } from "../src/accounting.js";
import { deriveReleaseSecret, matchReleaseTag, releaseKeyFingerprint, releaseTag, sha256Hex, solveSessionPow, startSessionPow, verifySessionPow } from "../src/node.js";

const base = { publicKey: "k".repeat(59) + "=", machineId: "c".repeat(64), appVersion: "1.2.3", platform: "darwin" as const, arch: "arm64" as const, timestamp: 1, nonce: "7b1f0c2e-5a6d-4b8c-9d0e-1f2a3b4c5d6e" };
const request = { method: "post", path: DESKTOP_FREE_CHAT_PATH, bodyHash: sha256Hex("{}"), authorizationHash: sha256Hex("") };

describe("protocol", () => {
  test("a v3 signature covers the release tag; the tag message never includes it", () => {
    const tag = "a".repeat(64);
    expect(JSON.parse(desktopFreeProofMessage({ version: 3, ...base, releaseTag: tag, ...request })).at(-1)).toBe(tag);
    expect(desktopFreeReleaseTagMessage({ ...base, ...request })).not.toContain(tag);
    expect(JSON.parse(desktopFreeProofMessage({ version: 2, ...base, ...request }))[1]).toBe("POST");
  });
  test("only the published routes are signable", () => {
    expect(isDesktopFreeSignableRoute("POST", DESKTOP_FREE_SESSION_PATH)).toBe(true);
    expect(isDesktopFreeSignableRoute("GET", MEMBER_FREE_STATUS_PATH)).toBe(true);
    expect(isDesktopFreeSignableRoute("GET", DESKTOP_FREE_SESSION_PATH)).toBe(false);
    expect(isDesktopFreeSignableRoute("DELETE", DESKTOP_FREE_CHAT_PATH)).toBe(false);
  });
});

describe("proof of work", () => {
  test("zero-bit counting and parameter clamping", () => {
    expect(leadingZeroBits(Uint8Array.from([0, 0x0f]))).toBe(12);
    expect(leadingZeroBits(Uint8Array.from([0x80]))).toBe(0);
    expect(clampSessionPowParams({ bits: "12", rounds: "3" }, { bits: 19, rounds: 8 })).toEqual({ bits: 12, rounds: 3 });
    expect(clampSessionPowParams({ bits: 40, rounds: 0 }, { bits: 19, rounds: 8 })).toEqual({ bits: 19, rounds: 8 });
  });
  test("solutions are bound to machine, nonce and round order", () => {
    const input = { machineId: base.machineId, nonce: base.nonce, bits: 8, rounds: 3 };
    const pow = solveSessionPow(input);
    expect(verifySessionPow({ ...input, pow })).toBe(true);
    expect(verifySessionPow({ ...input, nonce: "7b1f0c2e-5a6d-4b8c-9d0e-1f2a3b4c5d6f", pow })).toBe(false);
    expect(verifySessionPow({ ...input, pow: pow.split(".").reverse().join(".") })).toBe(false);
    expect(verifySessionPow({ ...input, pow: pow.split(".").slice(1).join(".") })).toBe(false);
    expect(verifySessionPow({ ...input, bits: 0, pow: undefined })).toBe(true);
  });
  test("the worker's solution is one the verifier accepts", async () => {
    const input = { machineId: base.machineId, nonce: base.nonce, bits: 8, rounds: 2 };
    const job = startSessionPow(input, true);
    expect(verifySessionPow({ ...input, pow: await job.promise })).toBe(true);
    const inline = startSessionPow(input, false);
    expect(verifySessionPow({ ...input, pow: await inline.promise })).toBe(true);
  });
});

describe("release secrets", () => {
  test("the key fingerprint is stable, differs per key, and does not reveal the key or any release secret", () => {
    const key = "k".repeat(40);
    expect(releaseKeyFingerprint(key)).toBe(releaseKeyFingerprint(` ${key} `));
    expect(releaseKeyFingerprint(key)).toMatch(/^[0-9a-f]{12}$/);
    expect(releaseKeyFingerprint(key)).not.toBe(releaseKeyFingerprint("j".repeat(40)));
    expect(Buffer.from(deriveReleaseSecret(key, "1.2.3")).toString("hex")).not.toContain(releaseKeyFingerprint(key));
  });
  const masterKey = "test-only-release-master-key-2222222222222222222";
  test("secret is HMAC(master, version) and the tag verifies only with the claimed version's secret", () => {
    const secret = deriveReleaseSecret(masterKey, "1.2.3");
    expect(Buffer.from(secret).toString("hex")).toBe(createHmac("sha256", masterKey).update("1.2.3").digest("hex"));
    const tag = releaseTag(secret, { ...base, ...request });
    const candidates = [{ secret: deriveReleaseSecret(masterKey, "1.2.2"), source: "old" }, { secret, source: "right" }];
    expect(matchReleaseTag(tag, candidates, { ...base, ...request })?.source).toBe("right");
    expect(matchReleaseTag(tag, candidates.slice(0, 1), { ...base, ...request })).toBeNull();
    expect(matchReleaseTag("not-hex", candidates, { ...base, ...request })).toBeNull();
    expect(() => deriveReleaseSecret("short", "1.2.3")).toThrow(/at least 32/);
  });
});

describe("release window", () => {
  const now = Date.parse("2026-09-23T12:00:00Z"), day = 86400000;
  const releases = [["1.2.3", 0], ["1.2.2", 2], ["1.2.1", 5], ["1.2.0", 10], ["1.1.9", 30]].map(([version, age]) => ({ version: String(version), publishedAt: now - Number(age) * day }));
  test("newest releases plus the floor, minus blocked, never prereleases", () => {
    expect(supportedDesktopReleases(releases, { count: 3, minDays: 14, blocked: [] }, now)).toEqual(["1.2.3", "1.2.2", "1.2.1", "1.2.0"]);
    expect(supportedDesktopReleases([...releases, { version: "1.3.0-alpha.1", publishedAt: now }], { count: 3, minDays: 0, blocked: ["1.2.2"] }, now)).toEqual(["1.2.3", "1.2.1"]);
    expect(lowestDesktopVersion(["1.2.3", "1.2.0", "1.2.1"])).toBe("1.2.0");
    expect(compareDesktopVersions("1.2.3-alpha", "1.2.3")).toBe(-1);
    expect(desktopFreeVersionError("1.1.9", ["1.2.3", "1.2.0"])?.minimumVersion).toBe("1.2.0");
    expect(desktopFreeVersionError("1.2.3", [])?.code).toBe("desktop_version_unavailable");
  });
  test("release lists parse from GitHub or a plain list, and reject malformed entries", () => {
    expect(parseDesktopReleases([{ tag_name: "v1.2.3", draft: false, prerelease: false, published_at: "2026-09-23T00:00:00Z" }, { tag_name: "v9", draft: true, prerelease: false, published_at: "2026-09-23T00:00:00Z" }])?.map((r) => r.version)).toEqual(["1.2.3"]);
    expect(parseDesktopReleases({ releases: [{ version: "v1.2.3", publishedAt: "2026-09-23T00:00:00Z" }] })?.[0].version).toBe("1.2.3");
    expect(parseDesktopReleases([{ tag_name: 1 }])).toBeNull();
    expect(parseDesktopReleases({ latestAppVersion: "1.2.3" })).toBeNull();
  });
});

describe("accounting", () => {
  test("cost from token counts, the reservation, and the activity ramp", () => {
    const prices = { inputPrice: 0.25, outputPrice: 1.2 };
    expect(freeUsageAmount(prices, 1_000_000, 0)).toBe(25_000_000);
    expect(freeRequestReservation({ ...prices, maxInputTokens: 1000, maxCompletionTokens: 1000 })).toBe(Math.ceil(freeUsageAmount(prices, 1000, 1000) * 1.1));
    const ramp = parseInstallRamp(DEFAULT_INSTALL_RAMP, 100_000_000);
    expect(ramp.map((step) => step.minutes)).toEqual([0, 10, 20, 30]);
    expect(rampedDeviceAmount({ installRamp: ramp, deviceWeeklyAmount: 100_000_000 }, 25 * 60000)).toBe(50_000_000);
    expect(() => parseInstallRamp("1:100000", 100_000_000)).toThrow();
    expect(() => parseInstallRamp("0:200000,5:100000", 100_000_000)).toThrow();
  });
});
