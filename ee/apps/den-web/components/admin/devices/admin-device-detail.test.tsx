import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { adminRemoteDeviceDetailResponseSchema, type AdminRemoteDeviceDetailResponse } from "@openwork/types/den/remote-devices";
import { AdminDeviceDetailView } from "./admin-device-detail";

const now = Date.parse("2026-11-10T12:00:00.000Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const desktop: AdminRemoteDeviceDetailResponse = adminRemoteDeviceDetailResponseSchema.parse({
  device: {
    id: "rdv_desktop1", kind: "desktop", provider: "openwork_desktop", source: "desktop_app", platform: "darwin", label: "Ada's MacBook Pro",
    availability: "needs_setup", state: "setup_required", statusDetail: "Screen Recording is off", lastSeenAt: ago(2), createdAt: ago(60 * 24 * 12),
    appVersion: "0.14.2", computerId: "cmp_install1", workbotChat: null,
    organization: { id: "org_acme", name: "Acme" }, owner: { memberId: "mem_ada", name: "Ada Lovelace", email: "ada@example.com" }, shared: false,
    externalId: "install-4f2a", removedAt: null, recentProblems: 1, lastEvent: null,
  },
  diagnostics: {
    reportedAt: ago(2), osVersion: "macOS 15.1", arch: "arm64",
    computerUse: {
      enabled: true, remoteEnabled: false, selectedId: "this-mac",
      computers: [
        { id: "this-mac", label: "This Mac", placement: "local", readiness: "setup-required", detail: "Screen Recording is off", provider: null, externalId: null },
        { id: "freestyle-vm", label: "Freestyle VM", placement: "remote", readiness: null, detail: null, provider: "freestyle", externalId: "vm_9" },
      ],
      permissions: { accessibility: true, screenRecording: false },
    },
  },
  events: [
    { id: "evt_2", type: "state_changed", level: "warning", message: "Computer use needs setup", actor: "device", createdAt: ago(2), data: { code: "screen_recording_off", attempts: 2 }, actorId: null },
    { id: "evt_1", type: "registered", level: "info", message: "Signed in on this computer", actor: "member", createdAt: ago(60 * 24 * 12), data: null, actorId: "mem_ada" },
  ],
  runner: { computerId: "cmp_install1", capabilities: ["remote-session", "automations"], appVersion: "0.14.2", lastSeenAt: ago(1), workspaces: 3, inventoryUpdatedAt: ago(30) },
  session: null,
  features: { remoteDevices: true, computerUse: true, remoteComputers: false, browserUse: true, sandboxGateway: false },
});

const workbot: AdminRemoteDeviceDetailResponse = {
  ...desktop,
  device: { ...desktop.device, id: "rdv_workbot1", kind: "vm", provider: "workbot", source: "workbot", platform: "linux", label: "Workbot's computer", availability: "paused", state: "paused", statusDetail: null, appVersion: null, computerId: null, workbotChat: "main", owner: null, removedAt: ago(5) },
  diagnostics: null,
  events: [],
  runner: null,
  session: { sessionId: "hs_abcdefgh", kind: "workbot", title: " ", updatedAt: ago(90), activeTurnSince: ago(4), deletedAt: null },
};

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("a desktop shows its ids, rollout, computer use, runner and activity in that order", () => {
  const html = renderToStaticMarkup(<AdminDeviceDetailView detail={desktop} raw={desktop} now={now} />);
  const order = ["Device id", "Features for the owner", "Computer use", "Runner", "Activity", "Raw response"].map((heading) => html.indexOf(`>${heading}<`));
  assert.ok(order.every((index) => index >= 0), `every section is present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);

  const plain = text(html);
  assert.match(plain, /Provider id install-4f2a/);
  assert.match(plain, /Source Reported by OpenWork Desktop/);
  assert.match(plain, /Platform macOS/);
  assert.match(plain, /Remote tasks id cmp_install1/);
  assert.match(plain, /Devices On/);
  assert.match(plain, /Remote computers Off/);
  assert.match(plain, /Accessibility Granted/);
  assert.match(plain, /Screen Recording Not granted/);
  assert.match(plain, /This Mac Agents use this one Screen Recording is off Local Needs setup/);
  assert.match(plain, /Freestyle VM Remote Not checked yet/);
  assert.match(plain, /Operating system macOS 15\.1 arm64/);
  assert.match(plain, /Reported 2 min ago/);
  assert.match(plain, /remote-session automations/);
  assert.match(plain, /Workspaces 3/);
  assert.match(plain, /Warning Computer use needs setup code=screen_recording_off attempts=2 Computer 2 min ago/);
  assert.match(plain, /Info Signed in on this computer Member 12 days ago/);
  assert.doesNotMatch(plain, /Workbot conversation|Removed|Workbot chat/);
  // The row in the list already says who owns it and how it is doing.
  assert.doesNotMatch(plain, /Last heard from|Organization/);
  assert.match(html, /<details[^>]*>(?:(?!<\/details>).)*Raw response/s, "raw JSON stays behind a closed disclosure");
  assert.doesNotMatch(html, /<details[^>]* open/);
});

test("a Workbot computer shows its conversation and leaves out what was never reported", () => {
  const plain = text(renderToStaticMarkup(<AdminDeviceDetailView detail={workbot} raw={workbot} now={now} />));
  assert.match(plain, /Source Reported by Workbot/);
  assert.match(plain, /Platform Linux/);
  assert.match(plain, /Removed /);
  assert.match(plain, /Workbot chat main/);
  assert.match(plain, /Workbot conversation Title Untitled Kind workbot Updated 1 hour ago Turn running since /);
  assert.match(plain, /Activity Nothing recorded yet\./);
  assert.doesNotMatch(plain, /Remote tasks id|Runner|Accessibility|Deleted/);
});

test("a computer opened from a link carries what its row would have shown", () => {
  const plain = text(renderToStaticMarkup(<AdminDeviceDetailView detail={desktop} raw={desktop} now={now} standalone />));
  assert.match(plain, /Type Mac Organization Acme Owner Ada Lovelace Availability Needs setup Screen Recording is off Last heard from 2 min ago App version 0\.14\.2 Device id/);
});

test("long activity is cut to the latest events until asked for", () => {
  const events: AdminRemoteDeviceDetailResponse["events"] = Array.from({ length: 45 }, (_, index) => ({ id: `evt_${index}`, type: "resumed", level: "info", message: `Resumed ${index}`, actor: "workbot", createdAt: ago(index), data: null, actorId: null }));
  const html = renderToStaticMarkup(<AdminDeviceDetailView detail={{ ...workbot, events }} raw={workbot} now={now} />);
  assert.equal(html.match(/data-testid="admin-device-event-/g)?.length, 20);
  assert.match(text(html), /Show all 45 events/);
});
