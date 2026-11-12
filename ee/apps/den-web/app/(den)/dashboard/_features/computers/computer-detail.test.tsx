import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { organizationComputerDetailResponseSchema, type RemoteDeviceAccess } from "@openwork/types/den/remote-devices";
import { ComputerDetailView } from "./computer-detail";

const now = Date.parse("2026-11-10T12:00:00Z");
const reported = "2026-11-10T11:58:00Z";
const desktop = organizationComputerDetailResponseSchema.parse({
  device: {
    id: "rdv_desktop1", kind: "desktop", provider: "openwork_desktop", source: "desktop_app", platform: "darwin", label: "Design laptop",
    availability: "needs_setup", state: "setup_required", statusDetail: "Screen Recording is off", lastSeenAt: reported, createdAt: reported,
    appVersion: "0.14.2-alpha.31+9f2c1ab", computerId: "cmp_install1", workbotChat: null, canRemove: false, disconnectedAt: null, canDisconnect: true,
    organization: { id: "org_example", name: "Example" }, owner: { memberId: "mem_alex", name: "Alex", email: "alex@example.com", former: false }, shared: false,
    externalId: "install-4f2a", removedAt: null, recentProblems: 1, lastEvent: null,
  },
  diagnostics: {
    reportedAt: reported, osVersion: "macOS 15.1", arch: "arm64",
    computerUse: {
      enabled: true, remoteEnabled: false, selectedId: "this-mac",
      computers: [{ id: "this-mac", label: "This Mac", placement: "local", readiness: "setup-required", detail: "Screen Recording is off", provider: null, externalId: null }],
      permissions: { accessibility: true, screenRecording: false },
    },
  },
  events: [],
  runner: { computerId: "cmp_install1", capabilities: ["remote-session", "automations"], appVersion: "0.14.2", lastSeenAt: reported, workspaces: 3, inventoryUpdatedAt: reported },
  session: null,
  features: { remoteDevices: true, computerUse: true, remoteComputers: false, browserUse: true, sandboxGateway: false },
});
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

test("computer detail renders supported inventory without platform navigation or raw JSON", () => {
  const html = renderToStaticMarkup(<ComputerDetailView detail={desktop} now={now} standalone />);
  const plain = text(html);
  assert.match(plain, /Type Mac Status Needs setup Screen Recording is off Owner Alex Last contact 2 min ago App version 0\.14\.2-alpha\.31\+9f2c1ab/);
  assert.match(plain, /Platform macOS/);
  assert.match(plain, /Operating system macOS 15\.1 arm64/);
  assert.match(plain, /Screen Recording Not granted/);
  assert.match(plain, /This Mac Agents use this one Screen Recording is off Local Needs setup/);
  assert.match(plain, /Workspaces 3 Inventory reported 2 min ago/);
  assert.doesNotMatch(html, /\/admin|Raw response|Features for the owner|<pre/);
  assert.match(html, /<details[^>]*><summary[^>]*>Technical details/);
  assert.doesNotMatch(html, /<details[^>]* open/);
});

test("session inventory exposes kind and report time, not conversation content", () => {
  const html = renderToStaticMarkup(<ComputerDetailView detail={{ ...desktop, diagnostics: null, runner: null, session: { sessionId: "session_a", kind: "workbot", updatedAt: reported, activeTurnSince: null, deletedAt: null } }} now={now} />);
  assert.match(text(html), /Workbot conversation Kind workbot Updated 2 min ago/);
  assert.doesNotMatch(html, /Title|Accessibility|Workspaces/);
});

test("inside the list the detail still names the owner, last contact and the full version, which a narrow list drops", () => {
  const plain = text(renderToStaticMarkup(<ComputerDetailView detail={desktop} now={now} />));
  assert.match(plain, /^ ?Owner Alex Last contact 2 min ago App version 0\.14\.2-alpha\.31\+9f2c1ab Provider OpenWork Desktop/);
  assert.doesNotMatch(plain, /Type Mac|Disconnected/);
});

test("a disconnected computer says so in neutral ink, with when, and a former member is never an address", () => {
  const cut = { ...desktop, device: { ...desktop.device, availability: "offline" as const, disconnectedAt: "2026-11-09T09:00:00Z", canDisconnect: false,
    owner: { memberId: "mem_gone", name: null, email: "retired-duplicate-usr_01@deleted.invalid", former: true } } };
  const html = renderToStaticMarkup(<ComputerDetailView detail={cut} now={now} standalone />);
  assert.match(text(html), /Status Disconnected Sign in on it again to reconnect Owner Former member/);
  assert.match(text(html), /Disconnected (Nov 9, 2026|9 Nov 2026)/);
  assert.doesNotMatch(html, /deleted\.invalid|ow-danger|Offline/);
});

test("the open detail says what other devices can do on a member's computer, and why, in the third person", () => {
  const withAccess = (remoteAccess: RemoteDeviceAccess | null) => ({ ...desktop, device: { ...desktop.device, remoteAccess } });
  const detail = (remoteAccess: RemoteDeviceAccess | null) => renderToStaticMarkup(<ComputerDetailView detail={withAccess(remoteAccess)} now={now} />);
  const cases: Array<[RemoteDeviceAccess, string]> = [
    [{ effective: "created", chosen: true, reason: null }, "Other devices can Start tasks Last contact"],
    [{ effective: "all", chosen: true, reason: null }, "Other devices can Start tasks and open sessions Last contact"],
    [{ effective: "off", chosen: true, reason: null }, "Other devices can Nothing Turned off by its owner. Last contact"],
    [{ effective: "off", chosen: false, reason: "not_chosen" }, "Other devices can Nothing Not allowed by its owner yet. Last contact"],
    [{ effective: "off", chosen: false, reason: "update_required" }, "Other devices can Nothing Needs an OpenWork update before its owner can allow it. Last contact"],
    [{ effective: "off", chosen: true, reason: "organization" }, "Other devices can Nothing Turned off for the organization. Last contact"],
    [{ effective: "created", chosen: true, reason: "organization" }, "Other devices can Start tasks The organization doesn't allow more. Last contact"],
  ];
  for (const [remoteAccess, expected] of cases) {
    const html = detail(remoteAccess);
    assert.ok(text(html).includes(`Owner Alex ${expected}`), `${JSON.stringify(remoteAccess)}: ${text(html).slice(0, 200)}`);
    assert.match(html, new RegExp(`data-testid="computer-remote-access-rdv_desktop1" data-remote-access="${remoteAccess.effective}"`));
    // Never the owner's wording, and nothing to press: an admin sees it, the owner changes it.
    assert.doesNotMatch(text(html), /Your organization|on that computer|Allow it in Settings|Change it/);
  }
  // A computer that takes no tasks this way, and an older API's detail, have no such row.
  assert.doesNotMatch(detail(null), /Other devices can|computer-remote-access/);
  assert.equal(desktop.device.remoteAccess, null, "the fixture is a detail without the field");
  assert.doesNotMatch(renderToStaticMarkup(<ComputerDetailView detail={desktop} now={now} standalone />), /Other devices can/);
});
