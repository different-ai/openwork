import { expect, test } from "bun:test";
import { autoAccessWall, autoAccessWallFromError, autoNotOffered, autoPickerCopy, autoQuietlyUnavailable, autoWallCopy, freeAutoSwitchedOff, modelForNewTask, unavailableDesktopFreeStatus } from "../src/app/lib/inference-access";

test("a deployment opt-out clears a saved Auto default for new tasks while retaining a personal model", () => {
  const status = { ...unavailableDesktopFreeStatus(), code: "free_disabled" };
  const auto = { providerID: status.providerID, modelID: status.modelID };
  const personal = { providerID: "personal", modelID: "working-model" };
  expect(freeAutoSwitchedOff(status)).toBe(true);
  expect(modelForNewTask(auto, status)).toBeNull();
  expect(modelForNewTask(personal, status)).toBe(personal);
});

test("Auto that is running but not offered to this organization says why, and never looks like an outage", () => {
  const subtitles = Object.fromEntries(["free_not_enrolled", "free_not_offered", "managed_models_disabled_for_dpa", "not_eligible"]
    .map((code) => [code, autoPickerCopy("not_offered", true, null, code).subtitle]));
  expect(subtitles).toEqual({
    free_not_enrolled: "Free · not on for your organization yet",
    free_not_offered: "Free · turned off by your organization",
    managed_models_disabled_for_dpa: "Free · not available for your organization",
    not_eligible: "Free · not available for this account",
  });
  for (const code of Object.keys(subtitles)) {
    expect(autoNotOffered({ code })).toBe(true);
    expect(freeAutoSwitchedOff({ code })).toBe(false);
    expect(autoPickerCopy("not_offered", true, null, code).action).toBeNull();
    const wall = autoAccessWall({ ...unavailableDesktopFreeStatus(), code });
    expect(wall).toMatchObject({ state: "not_offered", code });
    expect(autoWallCopy(wall!, true).title).not.toContain("temporarily");
  }
  expect(autoPickerCopy("unavailable", true).subtitle).toBe("Free · temporarily unavailable");
  expect(freeAutoSwitchedOff({ code: "free_disabled" })).toBe(true);
});

test("a client the free model is not served to changes nothing in the picker; a send says so in the chat", () => {
  const status = { ...unavailableDesktopFreeStatus(), code: "desktop_build_unverified" };
  expect(autoQuietlyUnavailable(status)).toBe(true);
  expect(autoQuietlyUnavailable({ code: "free_not_enrolled" })).toBe(false);
  expect(freeAutoSwitchedOff(status)).toBe(false);
  const wall = autoAccessWall(status);
  expect(wall).toMatchObject({ state: "not_offered", code: "desktop_build_unverified" });
  expect(autoWallCopy(wall!, false)).toEqual({ title: "You’ve reached the free Auto limit", detail: "Sign in for more free use, or pick another model.",
    technicalDetails: "Code: desktop_build_unverified" });
});

test("refusals read calmly, as the free limit when we turned Auto off, and keep the gateway's words under Technical details", () => {
  const now = Date.parse("2026-10-01T10:00:00Z");
  for (const wall of [{ state: "update" as const, code: "desktop_update_required", minimumVersion: "1.2.0" }, { state: "not_offered" as const, code: "free_not_offered" },
    { state: "not_offered" as const, code: "admin_disabled" }, { state: "not_offered" as const, code: "desktop_build_unverified" }]) {
    expect(autoWallCopy(wall, true, now)).toMatchObject({ title: "You’ve reached the free Auto limit", detail: "Pick another model to keep going." });
  }
  const daily = autoWallCopy({ state: "limit", code: "anonymous_limit_exceeded", resetsAt: "2026-10-01T13:00:00Z", message: "Free limit reached." }, false, now);
  expect(daily).toEqual({ title: "You’ve used your free Auto for now", detail: "It’s back in 3 hours. Sign in for more free use, or pick another model.",
    technicalDetails: "Code: anonymous_limit_exceeded\nMessage: Free limit reached.\nResets: 2026-10-01T13:00:00Z" });
  expect(autoWallCopy({ state: "limit", resetsAt: "2026-10-01T10:20:00Z" }, true, now).detail).toBe("It’s back in 20 minutes. Pick another model to keep going.");
  expect(autoWallCopy({ state: "limit", resetsAt: "2026-10-05T00:00:00Z" }, true, now).detail).toMatch(/^It’s back on \w+day\. Pick another model to keep going\.$/);
  expect(autoWallCopy({ state: "unavailable", code: "anonymous_capacity_exceeded" }, false, now)).toMatchObject({ title: "Auto is busy right now", detail: "Pick another model to keep going, or try Auto again in a bit." });
  expect(autoAccessWallFromError({ error: { code: "free_auto_busy", message: "Busy." } })).toEqual({ state: "unavailable", code: "free_auto_busy", message: "Busy." });
  expect(autoWallCopy({ state: "not_offered", code: "free_not_enrolled" }, true, now).title).toBe("Auto isn’t on for your organization yet");
  for (const state of ["limit", "update", "unavailable", "sync", "not_offered"] as const) {
    expect(JSON.stringify(autoWallCopy({ state }, false, now))).not.toMatch(/not processed|build|version|budget|IP|configur|\$|USD/i);
  }
  expect(autoQuietlyUnavailable({ code: "desktop_update_required" })).toBe(true);
});

test("Auto refusals that arrive mid-send, like a key swapped when a trial ends, never show a raw or API-key error", () => {
  const auto = { providerID: "openwork-free", modelID: "openai/gpt-6-luna" };
  for (const code of ["invalid_api_key", "free_member_unavailable", "free_inference_upstream_error", "free_inference_upstream_unavailable", "request_log_unavailable"]) {
    const wall = autoAccessWallFromError({ error: { code, message: "raw" } }, auto);
    expect(wall).toMatchObject({ state: "unavailable", code, message: "raw" });
    expect(autoWallCopy(wall!, true).title).toBe("Auto is busy right now");
  }
  for (const code of ["inference_disabled", "free_principal_rejected", "free_disabled"]) {
    expect(autoWallCopy(autoAccessWallFromError({ error: { code } }, auto)!, true).title).toBe("You’ve reached the free Auto limit");
  }
  expect(autoAccessWallFromError({ error: { code: "invalid_api_key" } }, { providerID: "openai", modelID: "gpt-5" })).toBeNull();
  expect(autoAccessWallFromError({ error: { code: "invalid_api_key" } })).toBeNull();
});

test("an older gateway's new-machine cap reads as the free limit, not as Auto being busy", () => {
  const wall = autoAccessWallFromError({ error: { code: "anonymous_new_identity_capped" } }, { providerID: "openwork-free", modelID: "openai/gpt-6-luna" });
  expect(wall).toMatchObject({ state: "limit", code: "anonymous_new_identity_capped" });
  expect(autoWallCopy(wall!, false).title).toBe("You’ve reached the free Auto limit");
});
