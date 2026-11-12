import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { remoteDeviceListResponseSchema, type RemoteDevice, type RemoteDeviceAccess, type RemoteDeviceEvent } from "@openwork/types/den/remote-devices";
import { MyComputerActivity, MyComputerRemoteAccess, MyComputerRows, onlineCount } from "./my-computers-screen";
import { myComputersQueryKey } from "./my-computers-data";

const now = Date.parse("2026-11-10T12:10:00Z");
const base: RemoteDevice = {
  id: "rdv_mine", kind: "desktop", provider: "openwork_desktop", source: "desktop_app", platform: "darwin", label: "Work laptop",
  access: "mine", availability: "online", state: "ready", statusDetail: null, lastSeenAt: "2026-11-10T12:08:00Z", createdAt: "2026-11-01T09:00:00Z",
  appVersion: "1.5.2", computerId: "cmp_1", workbotChat: null, canRename: true, canRemove: false, disconnectedAt: null, canDisconnect: true, remoteAccess: null,
};
const shared: RemoteDevice = {
  ...base, id: "rdv_shared", kind: "vm", provider: "mac_host", source: "manual", label: "Studio Mac", access: "shared",
  availability: "unknown", state: "unknown", lastSeenAt: null, appVersion: null, computerId: null, canRename: false, canRemove: false, canDisconnect: false,
};
const needsSetup: RemoteDevice = { ...base, id: "rdv_setup", platform: "win32", label: "Home PC", availability: "needs_setup", state: "setup_required", statusDetail: "Computer use needs setup", appVersion: "0.18.66-alpha.4137+053df1c" };
const disconnected: RemoteDevice = { ...base, id: "rdv_cut", label: "Old laptop", availability: "offline", disconnectedAt: "2026-11-09T09:00:00Z", canDisconnect: false, canRemove: true };

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const row = (html: string, id: string) => html.split('role="row"').find((part) => part.includes(`my-computer-row-${id}"`)) ?? "";
const rows = (devices: RemoteDevice[], openId = "", detail: (device: RemoteDevice) => React.ReactNode = () => null) =>
  renderToStaticMarkup(<MyComputerRows devices={devices} now={now} openId={openId} onToggle={() => {}} action={(device) => <span data-stub-menu={device.id} />} detail={detail} />);

test("a member's computers show what each is, its state, last contact and short version, with no owner lane", () => {
  const html = rows([base, needsSetup, shared, disconnected]);
  const page = text(html);
  assert.match(page, /Computer Status Last contact App version/);
  assert.doesNotMatch(page, /Owner|Belongs to/);
  assert.match(text(row(html, "rdv_mine")), /Work laptop Mac Online 2 min ago 1\.5\.2/);
  assert.match(text(row(html, "rdv_setup")), /Home PC Windows PC Needs setup Computer use needs setup 2 min ago 0\.18\.66 alpha/);
  assert.match(text(row(html, "rdv_shared")), /Studio Mac Mac sandbox Shared with your organization Not checked yet Never Not reported/);
  assert.match(text(row(html, "rdv_cut")), /Old laptop Mac Disconnected Sign in on it again to reconnect/);
  // Nothing an admin would need: no ids as text, no addresses.
  assert.doesNotMatch(page, /rdv_|@|cmp_/);
  assert.equal(html.match(/aria-expanded="false"/g)?.length, 4);
  assert.equal(html.match(/data-testid="my-computer-row-/g)?.length, 4);
  assert.doesNotMatch(html, /<table|<td/);
});

test("the header counts the computers that answer right now; a disconnected one never does", () => {
  assert.equal(onlineCount([base, needsSetup, shared, disconnected]), 1);
  assert.equal(onlineCount([{ availability: "online", disconnectedAt: "2026-11-09T09:00:00Z" }]), 0);
  assert.equal(onlineCount([]), 0);
});

test("two of a member's computers with one name say when each was added", () => {
  const html = rows([base, { ...base, id: "rdv_old", createdAt: "2026-08-14T09:00:00Z" }, shared]);
  assert.match(text(row(html, "rdv_mine")), /Work laptop Mac Added 1 Nov/);
  assert.match(text(row(html, "rdv_old")), /Work laptop Mac Added 14 Aug/);
  assert.doesNotMatch(text(row(html, "rdv_shared")), /Added/);
});

test("opening a computer shows its recent activity in plain sentences, without codes", () => {
  const events: RemoteDeviceEvent[] = [
    { id: "rde_2", type: "state_changed", level: "warning", message: "Needs setup: Screen Recording is off", actor: "device", createdAt: "2026-11-10T12:05:00Z" },
    { id: "rde_1", type: "registered", level: "info", message: "Signed in on OpenWork 1.5.2", actor: "device", createdAt: "2026-11-10T09:00:00Z" },
  ];
  const html = rows([base], "rdv_mine", () => <MyComputerActivity events={events} now={now} />);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /id="my-computer-activity-rdv_mine"/);
  const page = text(html);
  assert.match(page, /Needs setup: Screen Recording is off 5 min ago/);
  assert.match(page, /Signed in on OpenWork 1\.5\.2 3 hours ago/);
  assert.doesNotMatch(page, /state_changed|registered|rde_/);
  assert.match(text(renderToStaticMarkup(<MyComputerActivity events={[]} now={now} />)), /Nothing recorded yet\./);
});

const access = (effective: RemoteDeviceAccess["effective"], reason: RemoteDeviceAccess["reason"] = null, chosen = true): RemoteDeviceAccess => ({ effective, chosen, reason });
/** The lane cell and the narrow line of one computer's row. */
const laneOf = (html: string, id: string) => row(html, id).match(/<div role="cell"[^>]*hidden w-52 @2xl:flex[^>]*>.*?<\/div>/)?.[0] ?? "";
const belowOf = (html: string, id: string) => row(html, id).match(/<div role="cell" class="basis-full[^>]*>.*?<\/div>/)?.[0] ?? "";

test("every desktop says what other devices can do on it without being opened, in a lane and, on a narrow list, a line under the row", () => {
  const html = rows([
    { ...base, remoteAccess: access("created") },
    { ...needsSetup, remoteAccess: access("all") },
    { ...disconnected, id: "rdv_off", label: "Spare laptop", disconnectedAt: null, remoteAccess: access("off", "not_chosen", false) },
    shared,
  ]);
  assert.match(text(html), /Computer Status Other devices can Last contact App version/);
  // The lane: the value, and under it the reason when something other than the owner's choice decides it.
  assert.equal(text(laneOf(html, "rdv_mine")).trim(), "Start tasks");
  assert.equal(text(laneOf(html, "rdv_setup")).trim(), "Start tasks and open sessions");
  assert.equal(text(laneOf(html, "rdv_off")).trim(), "Nothing Not allowed yet. Allow it in Settings › Devices on that computer.");
  assert.match(laneOf(html, "rdv_off"), /title="Not allowed yet\. Allow it in Settings › Devices on that computer\."/);
  assert.match(laneOf(html, "rdv_off"), /data-remote-access="off"/);
  // The same on a list too narrow for the lane: a line across the row, with the lane's label.
  assert.equal(text(belowOf(html, "rdv_mine")).trim(), "Other devices can: Start tasks");
  assert.equal(text(belowOf(html, "rdv_off")).trim(), "Other devices can: Nothing Not allowed yet. Allow it in Settings › Devices on that computer.");
  assert.match(belowOf(html, "rdv_mine"), /@2xl:hidden/);
  // A computer that takes no tasks this way keeps its lane empty, so rows still line up, and has no line.
  assert.equal(text(laneOf(html, "rdv_shared")).trim(), "");
  assert.match(laneOf(html, "rdv_shared"), /role="cell"/);
  assert.equal(belowOf(html, "rdv_shared"), "");
  // Read-only: it is changed on the computer, not from this list.
  assert.doesNotMatch(laneOf(html, "rdv_mine") + belowOf(html, "rdv_off"), /<button|<a |<input/);
});

test("a list where no computer says it, as from an older API, has no lane and no line at all", () => {
  // `remoteAccess: null` everywhere: virtual computers, disconnected desktops, or an API that does not send it.
  const html = rows([base, needsSetup, shared, disconnected]);
  assert.match(text(html), /Computer Status Last contact App version/);
  assert.doesNotMatch(html, /Other devices can|data-remote-access|basis-full/);
  assert.equal(laneOf(html, "rdv_mine"), "");

  // The payload itself: an older API's device has no `remoteAccess`, which reads as null.
  const { remoteAccess: _omitted, disconnectedAt: _disconnectedAt, canDisconnect: _canDisconnect, ...older } = base;
  const parsed = remoteDeviceListResponseSchema.parse({ devices: [older] });
  assert.equal(parsed.devices[0]?.remoteAccess, null);
  const fromOlder = rows(parsed.devices);
  assert.match(text(row(fromOlder, "rdv_mine")), /Work laptop Mac Online 2 min ago 1\.5\.2/);
  assert.doesNotMatch(fromOlder, /Other devices can/);
  assert.equal(renderToStaticMarkup(<MyComputerRemoteAccess access={parsed.devices[0]?.remoteAccess ?? null} />), "");
});

test("an open computer says what other devices can do there, why, and where to change it", () => {
  const open = (value: RemoteDeviceAccess) => renderToStaticMarkup(<MyComputerRemoteAccess access={value} />);
  // The owner's own choice applies: the value, and where it is changed.
  assert.equal(text(open(access("created"))).trim(), "Other devices can: Start tasks Change it in Settings › Devices on that computer.");
  assert.equal(text(open(access("all"))).trim(), "Other devices can: Start tasks and open sessions Change it in Settings › Devices on that computer.");
  assert.equal(text(open(access("off"))).trim(), "Other devices can: Nothing Turned off on that computer. Change it in Settings › Devices on that computer.");
  // The organization allows less than the owner chose: they can still narrow it there.
  assert.equal(text(open(access("created", "organization"))).trim(), "Other devices can: Start tasks Your organization doesn't allow more. Change it in Settings › Devices on that computer.");
  // Nothing the owner changes there would help, or the note already says what to do.
  assert.equal(text(open(access("off", "organization"))).trim(), "Other devices can: Nothing Your organization has turned this off.");
  assert.equal(text(open(access("off", "not_chosen", false))).trim(), "Other devices can: Nothing Not allowed yet. Allow it in Settings › Devices on that computer.");
  assert.equal(text(open(access("off", "update_required", false))).trim(), "Other devices can: Nothing Update OpenWork on this computer to allow it.");
  assert.match(open(access("off", "not_chosen", false)), /data-testid="my-computer-access" data-remote-access="off"/);
  // Read-only here: the choice is made on the computer.
  assert.doesNotMatch(open(access("created")), /<button|<input|<a |<select/);
  // A computer that takes no tasks this way says nothing.
  assert.equal(renderToStaticMarkup(<MyComputerRemoteAccess access={null} />), "");
});

test("the list is cached per organization and member, never shared between them", () => {
  assert.notDeepEqual(myComputersQueryKey("org_a", "om_1"), myComputersQueryKey("org_a", "om_2"));
  assert.notDeepEqual(myComputersQueryKey("org_a", "om_1"), myComputersQueryKey("org_b", "om_1"));
});
