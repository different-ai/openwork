import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { INFERENCE_FREE_MODEL_ID } from "@openwork/types/den/inference";
import {
  DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_CHAT_PATH, DESKTOP_FREE_RESPONSES_PATH, MEMBER_FREE_RESPONSES_PATH, DESKTOP_FREE_SESSION_PATH, MEMBER_FREE_STATUS_PATH, clampSessionPowParams, compareDesktopVersions,
  desktopFreeProofMessage, desktopFreeReleaseTagMessage, desktopFreeVersionError, isDesktopFreeSignableRoute, leadingZeroBits,
} from "../src/index.js";
import { freeUsageAmount, parseInstallRamp, rampedDeviceAmount, DEFAULT_INSTALL_RAMP } from "../src/accounting.js";
import { deriveReleaseSecret, matchReleaseTag, releaseKeyFingerprint, releaseTag, sha256Hex, solveSessionPow, startSessionPow, verifySessionPow } from "../src/node.js";

const base = { publicKey: "k".repeat(59) + "=", machineId: "c".repeat(64), appVersion: "1.2.3", platform: "darwin" as const, arch: "arm64" as const, timestamp: 1, nonce: "7b1f0c2e-5a6d-4b8c-9d0e-1f2a3b4c5d6e" };
const request = { method: "post", path: DESKTOP_FREE_CHAT_PATH, bodyHash: sha256Hex("{}"), authorizationHash: sha256Hex("") };

describe("protocol", () => {
  test("the desktop and gateway advertise the same Auto model", () => {
    expect(DESKTOP_FREE_MODEL_ID).toBe(INFERENCE_FREE_MODEL_ID);
  });
  test("a v3 signature covers the release tag; the tag message never includes it", () => {
    const tag = "a".repeat(64);
    expect(JSON.parse(desktopFreeProofMessage({ version: 3, ...base, releaseTag: tag, ...request })).at(-1)).toBe(tag);
    expect(desktopFreeReleaseTagMessage({ ...base, ...request })).not.toContain(tag);
    expect(JSON.parse(desktopFreeProofMessage({ version: 2, ...base, ...request }))[1]).toBe("POST");
  });
  test("only the published routes are signable", () => {
    expect(isDesktopFreeSignableRoute("POST", DESKTOP_FREE_SESSION_PATH)).toBe(true);
    expect(isDesktopFreeSignableRoute("POST", DESKTOP_FREE_RESPONSES_PATH)).toBe(true);
    expect(isDesktopFreeSignableRoute("POST", MEMBER_FREE_RESPONSES_PATH)).toBe(true);
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

describe("version policy", () => {
  test("every version passes by default; blocked or below the minimum is asked to update", () => {
    const open = { minimumVersion: null, blocked: [] };
    expect(desktopFreeVersionError("0.18.55-alpha.3244+4d3cfbd", open)).toBeNull();
    expect(desktopFreeVersionError("0.1.0", open)).toBeNull();
    expect(desktopFreeVersionError("0.18.55-alpha.3244+4d3cfbd", { minimumVersion: null, blocked: ["0.18.55-alpha.3244"] }))
      .toEqual({ code: "desktop_update_required", currentVersion: "0.18.55-alpha.3244+4d3cfbd", minimumVersion: null, message: "Update OpenWork Desktop to use Auto." });
    expect(desktopFreeVersionError("1.1.9", { minimumVersion: "1.2.0", blocked: [] })?.message).toBe("Update OpenWork Desktop to 1.2.0 or newer to use Auto.");
    expect(desktopFreeVersionError("1.2.0", { minimumVersion: "1.2.0", blocked: [] })).toBeNull();
    expect(desktopFreeVersionError("not-a-version", { minimumVersion: "1.2.0", blocked: [] })?.code).toBe("desktop_update_required");
    expect(compareDesktopVersions("1.2.3-alpha", "1.2.3")).toBe(-1);
  });
});

describe("accounting", () => {
  test("cost from token counts and the activity ramp", () => {
    const prices = { inputPrice: 0.25, outputPrice: 1.2 };
    expect(freeUsageAmount(prices, 1_000_000, 0)).toBe(50_000_000);
    const luna = { inputPrice: 0.1, outputPrice: 0.5 };
    expect(freeUsageAmount(luna, 272_000, 2_000)).toBe(2_820_000);
    expect(freeUsageAmount(luna, 272_001, 2_000)).toBe(5_590_020);
    const ramp = parseInstallRamp(DEFAULT_INSTALL_RAMP, 100_000_000);
    expect(ramp.map((step) => step.minutes)).toEqual([0, 10, 20, 30]);
    expect(rampedDeviceAmount({ installRamp: ramp, deviceWeeklyAmount: 100_000_000 }, 25 * 60000)).toBe(50_000_000);
    expect(() => parseInstallRamp("1:100000", 100_000_000)).toThrow();
    expect(() => parseInstallRamp("0:200000,5:100000", 100_000_000)).toThrow();
  });
});
