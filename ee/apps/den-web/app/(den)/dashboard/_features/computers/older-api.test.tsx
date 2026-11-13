import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { remoteDeviceDetailResponseSchema, remoteDeviceListResponseSchema } from "@openwork/types/den/remote-devices";
import { myComputerActions, removeConfirm, disconnectOwnConfirm, teamComputerActions } from "./computer-actions";
import type { ComputerActionSet } from "./computer-action-controls";
import { ComputerDetailView } from "./computer-detail";
import { parseComputerDetail, parseComputerList } from "./computers-data";
import { computersStateLine } from "./computers-format";
import { StaleComputersLine, TeamComputerControl, TeamComputerRows } from "./computers-screen";
import { MyComputerRows, onlineCount } from "./my-computers-screen";

/*
 * Den web and the Den API deploy separately. These are the payloads of an API
 * from before computers could be disconnected: none of `disconnectedAt`,
 * `canDisconnect`, `owner.former`, `online`, `staleHidden`, and no `canRemove`
 * on a team computer. The pages must show what they know and offer nothing more.
 */
const now = Date.parse("2026-11-10T12:10:00Z");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const oldTeamComputer = {
  id: "rdv_mac", kind: "desktop", provider: "openwork_desktop", source: "desktop_app", platform: "darwin", label: "Alex's MacBook Pro",
  availability: "online", state: "ready", statusDetail: null, lastSeenAt: "2026-11-10T12:08:00Z", createdAt: "2026-11-03T12:00:00Z",
  appVersion: "1.5.2", computerId: "cmp_1", workbotChat: null,
  organization: { id: "org_1", name: "Fieldnotes Studio" }, owner: { memberId: "mem_alex", name: "Alex Morgan", email: "alex@example.com" }, shared: false,
  externalId: "install-1", removedAt: null, recentProblems: 0, lastEvent: null,
};
const oldList = {
  devices: [oldTeamComputer, { ...oldTeamComputer, id: "rdv_gone", label: "Old iMac", availability: "offline", owner: null }],
  total: 17, page: 1, pageSize: 50, instances: [], instancesTotal: 0, instancePage: 1, instancePageSize: 50,
};
const noActions = (name: string): ComputerActionSet => ({
  actions: [], name, disconnectConfirm: disconnectOwnConfirm(name), removeConfirm: removeConfirm(name), onDisconnect: async () => {}, onRemove: async () => {},
});

test("a team list from an older API parses, and reads as connected computers nobody can act on", () => {
  const list = parseComputerList(oldList);
  assert.ok(list, "the older list did not parse");
  assert.equal(list.online, undefined);
  assert.equal(list.staleHidden, 0);
  assert.equal(list.actionsReported, false);
  assert.deepEqual(list.devices.map((device) => [device.disconnectedAt, device.canDisconnect, device.canRemove, device.owner?.former ?? null]),
    [[null, false, false, false], [null, false, false, null]]);
  for (const device of list.devices) assert.deepEqual(teamComputerActions(device), []);
  // Nor does it say what other devices can do on a computer: nothing is shown for it.
  assert.deepEqual(list.devices.map((device) => device.remoteAccess), [null, null]);

  // No count of who is online when the API sent none: just how many there are.
  assert.equal(computersStateLine({ online: list.online, total: list.total }), "17 computers");
  assert.equal(computersStateLine({ online: list.online, total: 1 }), "1 computer");
  assert.equal(computersStateLine({ online: list.online, total: 4, filtered: true }), "4 matching computers");
  assert.equal(computersStateLine({ online: list.online, total: 0 }), "No computers yet");
  // No line about computers left out, since none were.
  assert.equal(renderToStaticMarkup(<StaleComputersLine hidden={list.staleHidden} shown={false} onShow={() => {}} onHide={() => {}} />), "");

  const html = renderToStaticMarkup(<TeamComputerRows devices={list.devices} now={now} openId="" onToggle={() => {}} detail={() => null}
    action={(device) => <TeamComputerControl device={device} set={noActions(device.label)} canDisconnectComputers={false} actionsReported={list.actionsReported} />} />);
  assert.match(text(html), /Alex's MacBook Pro Mac A Alex Morgan Online 2 min ago 1\.5\.2/);
  assert.match(text(html), /Old iMac Mac Former member Offline/);
  // Nothing to press beyond opening the row, and no lock pointing at a permission that API does not have.
  assert.doesNotMatch(html, /computer-menu-|computer-locked-|Disconnected|aria-label="Actions for/);
  assert.equal(html.match(/<button/g)?.length, 2);
});

test("a current API is recognised as one, so its locks and menus show", () => {
  const current = parseComputerList({ ...oldList, online: 1, staleHidden: 3, devices: [{ ...oldTeamComputer, canRemove: false, canDisconnect: false, disconnectedAt: null }] });
  assert.ok(current);
  assert.equal(current.actionsReported, true);
  assert.equal(current.online, 1);
  assert.equal(current.staleHidden, 3);
  const locked = renderToStaticMarkup(<TeamComputerControl device={current.devices[0]!} set={noActions("x")} canDisconnectComputers={false} actionsReported={current.actionsReported} />);
  assert.match(locked, /computer-locked-rdv_mac/);
  // An empty list offers nothing either way.
  assert.equal(parseComputerList({ ...oldList, devices: [], total: 0 })?.actionsReported, true);
  assert.equal(parseComputerList({ devices: "nope" }), null);
  assert.equal(parseComputerList(null), null);
});

test("one computer's detail from an older API parses and renders", () => {
  const detail = parseComputerDetail({
    device: oldTeamComputer, diagnostics: null, events: [], runner: null, session: null,
    features: { remoteDevices: true, remoteComputers: false, sandboxGateway: false },
  });
  assert.ok(detail, "the older detail did not parse");
  assert.equal(detail.device.canRemove, false);
  const plain = text(renderToStaticMarkup(<ComputerDetailView detail={detail} now={now} standalone />));
  assert.match(plain, /Type Mac Status Online Owner Alex Morgan Last contact 2 min ago App version 1\.5\.2/);
  assert.doesNotMatch(plain, /Disconnected|Other devices can/);
  assert.equal(detail.device.remoteAccess, null);
  assert.equal(parseComputerDetail({ device: null }), null);
});

test("a member's own list from an older API parses, with nothing to disconnect and no menu where nothing is offered", () => {
  const oldMine = {
    id: "rdv_mine", kind: "desktop", provider: "openwork_desktop", source: "desktop_app", platform: "darwin", label: "Work laptop",
    access: "mine", availability: "online", state: "ready", statusDetail: null, lastSeenAt: "2026-11-10T12:08:00Z", createdAt: "2026-11-01T09:00:00Z",
    appVersion: "1.5.2", computerId: null, workbotChat: null, canRename: false, canRemove: false,
  };
  const parsed = remoteDeviceListResponseSchema.safeParse({ devices: [oldMine] });
  assert.ok(parsed.success, "the older list did not parse");
  const [device] = parsed.data.devices;
  assert.ok(device);
  assert.equal(device.disconnectedAt, null);
  assert.equal(device.canDisconnect, false);
  assert.equal(device.remoteAccess, null);
  assert.deepEqual(myComputerActions(device), []);
  assert.equal(computersStateLine({ online: onlineCount(parsed.data.devices), total: 1 }), "1 of 1 online");
  const html = renderToStaticMarkup(<MyComputerRows devices={parsed.data.devices} now={now} openId="" onToggle={() => {}} action={() => null} detail={() => null} />);
  assert.match(text(html), /Work laptop Mac Online 2 min ago 1\.5\.2/);
  assert.doesNotMatch(html, /Disconnected|my-computer-menu-|Other devices can/);
  assert.ok(remoteDeviceDetailResponseSchema.safeParse({ device: oldMine, events: [] }).success);
});
