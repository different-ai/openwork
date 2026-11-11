import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteDevice, RemoteDeviceEvent } from "@openwork/types/den/remote-devices";
import { MyComputerAccessLine, MyComputerActivity, MyComputerRows, onlineCount } from "./my-computers-screen";
import { myComputersQueryKey } from "./my-computers-data";

const now = Date.parse("2026-11-10T12:10:00Z");
const base: RemoteDevice = {
  id: "rdv_mine", kind: "desktop", provider: "openwork_desktop", source: "desktop_app", platform: "darwin", label: "Work laptop",
  access: "mine", availability: "online", state: "ready", statusDetail: null, lastSeenAt: "2026-11-10T12:08:00Z", createdAt: "2026-11-01T09:00:00Z",
  appVersion: "1.5.2", computerId: "cmp_1", workbotChat: null, canRename: true, canRemove: false, disconnectedAt: null, canDisconnect: true,
};
const shared: RemoteDevice = {
  ...base, id: "rdv_shared", kind: "vm", provider: "mac_host", source: "manual", label: "Studio Mac", access: "shared",
  availability: "unknown", state: "unknown", lastSeenAt: null, appVersion: null, computerId: null, canRename: false, canRemove: false, canDisconnect: false,
};
const needsSetup: RemoteDevice = { ...base, id: "rdv_setup", platform: "win32", label: "Home PC", availability: "needs_setup", state: "setup_required", statusDetail: "Computer use needs setup", appVersion: "0.18.66-alpha.4137+053df1c" };
const disconnected: RemoteDevice = { ...base, id: "rdv_cut", label: "Old laptop", availability: "offline", disconnectedAt: "2026-11-09T09:00:00Z", canDisconnect: false, canRemove: true };

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
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

test("an open computer says what other devices can reach there, with the note My Sessions gives", () => {
  const computer = { supportsAccess: true, access: "created", effectiveAccess: "created" } as const;
  const narrow = renderToStaticMarkup(<MyComputerAccessLine computer={computer} ceiling="created" />);
  assert.match(text(narrow), /Other devices can reach: Only sessions started remotely Your organization only allows sessions started remotely\./);
  assert.match(text(renderToStaticMarkup(<MyComputerAccessLine computer={computer} ceiling="all" />)), /Other devices can reach: Only sessions started remotely Change this in Settings › Devices on that computer\./);
  const open = text(renderToStaticMarkup(<MyComputerAccessLine computer={{ supportsAccess: true, access: "all", effectiveAccess: "all" }} ceiling="all" />));
  assert.match(open, /Other devices can reach: All sessions/);
  assert.doesNotMatch(open, /Change this|only allows/);
  // Read-only here: the choice is made on the computer.
  assert.doesNotMatch(narrow, /<button|<input|<a /);
});

test("the list is cached per organization and member, never shared between them", () => {
  assert.notDeepEqual(myComputersQueryKey("org_a", "om_1"), myComputersQueryKey("org_a", "om_2"));
  assert.notDeepEqual(myComputersQueryKey("org_a", "om_1"), myComputersQueryKey("org_b", "om_1"));
});
