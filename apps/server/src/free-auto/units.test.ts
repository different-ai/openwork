import { expect, test } from "bun:test";
import { DESKTOP_FREE_MODEL_ID, MEMBER_FREE_STATUS_PATH, type DesktopFreeAccessStatus } from "@openwork/free-auto";
import { ACTIVATION_IDLE_MS, ACTIVATION_MAX_MS, TaskActivation, taskRoute } from "./activation.js";
import { memberCredentialFailure, parseGuestSession, parseMemberCredential, parseStatus, requestedSessionPow, statusFromRejection } from "./responses.js";
import { isOwnedProvider, ownedProvider } from "./provider-config.js";
import { readRelaySettings } from "./settings.js";

const base: DesktopFreeAccessStatus = { state: "unavailable", code: "anonymous_unavailable", currentVersion: "1.0.0", minimumVersion: null, providerID: "openwork-free", modelID: DESKTOP_FREE_MODEL_ID, allowance: null };
const allowance = { limitUsd: 1, usedUsd: 0, reservedUsd: 0, remainingUsd: 1, resetsAt: "2026-10-01T00:00:00.000Z" };

test("task routes: sends open, abort and delete end, anything else is ignored", () => {
  expect(taskRoute("POST", "/opencode2/api/session/s%201/message")).toEqual({ kind: "start", sessionID: "s 1" });
  expect(taskRoute("POST", "/session/a/prompt_async")).toEqual({ kind: "start", sessionID: "a" });
  expect(taskRoute("POST", "/session/a/abort")).toEqual({ kind: "end", sessionID: "a" });
  expect(taskRoute("DELETE", "/session/a")).toEqual({ kind: "end", sessionID: "a" });
  expect(taskRoute("GET", "/session/a/message")).toBeNull();
  expect(taskRoute("POST", "/session/a")).toBeNull();
});

test("activation idles out, caps, and closes when the last session ends", () => {
  let now = 0;
  const activation = new TaskActivation(() => now);
  expect(activation.allows(null)).toBe(false);
  activation.start("a"); activation.start("b");
  expect(activation.allows("a")).toBe(true);
  expect(activation.allows("c")).toBe(false);
  activation.end("a");
  expect(activation.allows(null)).toBe(true);
  now = ACTIVATION_IDLE_MS - 1; activation.touch();
  now += ACTIVATION_IDLE_MS - 1;
  expect(activation.isOpen()).toBe(true);
  now = ACTIVATION_MAX_MS;
  expect(activation.isOpen()).toBe(false);
  activation.start("a"); activation.end("a");
  expect(activation.isOpen()).toBe(false);
});

test("status parsing keeps a complete ready status and rejects anything partial", () => {
  const ready = parseStatus({ state: "ready", minimumVersion: "1.0.0", allowance, catalog: [{ nope: true }] }, base);
  expect(ready).toMatchObject({ state: "ready", minimumVersion: "1.0.0", allowance, catalog: [] });
  expect(() => parseStatus({ state: "ready", allowance }, base)).toThrow();
  expect(() => parseStatus({ state: "ready", minimumVersion: "1.0.0", allowance: { ...allowance, usedUsd: -1 } }, base)).toThrow();
  expect(() => parseStatus({ state: "later" }, base)).toThrow();
  expect(statusFromRejection({ code: "desktop_update_required", minimumVersion: "2.0.0" }, base)).toMatchObject({ state: "update_required", minimumVersion: "2.0.0" });
  expect(statusFromRejection({ code: "free_allowance_exhausted" }, base).state).toBe("exhausted");
  expect(statusFromRejection({}, base)).toMatchObject({ state: "unavailable", code: "anonymous_unavailable" });
});

test("guest sessions, extra work requests, and member credentials are validated before use", () => {
  expect(parseGuestSession({ token: "t", expiresAt: 2, model: DESKTOP_FREE_MODEL_ID }, 1)).toEqual({ token: "t", expiresAt: 2, model: DESKTOP_FREE_MODEL_ID });
  expect(() => parseGuestSession({ token: "t", expiresAt: 1, model: DESKTOP_FREE_MODEL_ID }, 1)).toThrow();
  const current = { bits: 19, rounds: 8 };
  expect(requestedSessionPow({ code: "session_pow_required", bits: 20 }, current)).toEqual({ bits: 20, rounds: 8 });
  expect(requestedSessionPow({ code: "session_pow_required", bits: 19 }, current)).toBeNull();
  expect(requestedSessionPow({ code: "session_pow_required", bits: 99 }, current)).toBeNull();
  expect(requestedSessionPow({ code: "other", bits: 20 }, current)).toBeNull();
  const origin = "https://inference.example";
  const apiKey = `ow_inf_${"a".repeat(43)}`;
  const credential = { apiKey, modelID: DESKTOP_FREE_MODEL_ID, baseURL: `${origin}/api/v1`, statusURL: `${origin}${MEMBER_FREE_STATUS_PATH}` };
  expect(parseMemberCredential({ credential }, origin)).toBe(apiKey);
  expect(() => parseMemberCredential({ credential: { ...credential, baseURL: "https://evil.example/api/v1" } }, origin)).toThrow();
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  expect(memberCredentialFailure(403, encode({ error: "free_disabled" }))).toEqual({ status: 403, code: "free_disabled" });
  expect(memberCredentialFailure(500, encode({ error: "whatever" }))).toEqual({ status: 503, code: "member_free_credentials_unavailable" });
});

test("the relay owns only the provider entry it wrote, and settings fall back on bad input", () => {
  const token = `owf_local_${"b".repeat(43)}`;
  expect(isOwnedProvider(ownedProvider(token, 4321))).toBe(true);
  expect(isOwnedProvider({ ...ownedProvider(token, 4321), name: "Mine" })).toBe(false);
  const settings = readRelaySettings({ OPENWORK_FREE_SESSION_POW_BITS: "40", OPENWORK_FREE_HEARTBEAT_MS: "-1", OPENWORK_DISABLE_FREE_INFERENCE: "yes" });
  expect(settings).toMatchObject({ origin: "https://inference.openworklabs.com", pow: { bits: 19, rounds: 8 }, heartbeatMs: 60_000, disabledByEnvironment: true, allowLocalDen: false });
});
