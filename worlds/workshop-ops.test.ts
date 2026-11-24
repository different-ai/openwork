import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fleetSeat } from "./workshop-fleetctl.ts";
import { workshopUnlockScript } from "./lib/workshop-unlock.ts";
import { workshopRemoteScript } from "./lib/workshop-browser.ts";
import { typeThroughWorkshopViewer } from "./lib/workshop-viewer.ts";

const seat = { attendee: "attendee01", sandbox: { id: "11111111-1111-4111-8111-111111111111" }, viewer: "https://private.invalid/vnc.html?view_only=0", expiresAt: new Date(Date.now() + 60_000).toISOString() };
test("operator selects exactly one owned manifest seat and refuses arbitrary or expired targets", () => {
  assert.equal(fleetSeat({ seats: [seat] }, "attendee01").id, seat.sandbox.id);
  assert.throws(() => fleetSeat({ seats: [seat, seat] }, "attendee01"));
  assert.throws(() => fleetSeat({ seats: [seat] }, "attendee02"));
  assert.throws(() => fleetSeat({ seats: [seat] }, "all"));
  assert.throws(() => fleetSeat({ seats: [{ ...seat, expiresAt: "2000-01-01T00:00:00Z" }] }, "attendee01"));
});
test("workshop-only unlock uses the existing X display, current UID, and disables idle password walls", () => {
  const script = workshopUnlockScript();
  execFileSync("bash", ["-n"], { input: script });
  assert.ok(!workshopRemoteScript(script).includes("'"));
  assert.ok(script.includes("DISPLAY=:99"));
  assert.ok(script.includes('pkill -u "$(id -u)"'));
  assert.ok(script.includes("xset s off") && script.includes("xset -dpms"));
  assert.ok(script.includes("Hidden=true"));
  assert.doesNotMatch(script, /\bpasswd\b|sudo|reset-all/);
});
test("interactive viewer proof rejects secrets and arbitrary input before opening a socket", async () => {
  await assert.rejects(typeThroughWorkshopViewer("https://private.invalid", "contains spaces and credentials"));
  await assert.rejects(typeThroughWorkshopViewer("https://private.invalid", ""));
});
