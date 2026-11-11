import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { organizationComputerListResponseSchema } from "@openwork/types/den/remote-devices";
import { disconnectOwnConfirm, removeConfirm } from "./computer-actions";
import type { ComputerActionSet } from "./computer-action-controls";
import type { OrganizationComputer } from "./computers-format";
import { ComputersPageHeader, StaleComputersLine, TeamComputerControl, TeamComputerRows } from "./computers-screen";

const now = Date.parse("2026-11-10T12:10:00Z");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
/** One computer's row: everything from its `role="row"` to the next. */
const row = (html: string, id: string) => html.split('role="row"').find((part) => part.includes(`computer-row-${id}"`)) ?? "";

const desktop: OrganizationComputer = {
  id: "rdv_mac", kind: "desktop", provider: "openwork_desktop", source: "desktop_app", platform: "darwin", label: "Alex's MacBook Pro",
  availability: "online", state: "ready", statusDetail: null, lastSeenAt: "2026-11-10T12:08:00Z", createdAt: "2026-11-03T12:00:00Z",
  appVersion: "0.18.66-alpha.4137+053df1c", computerId: "cmp_1", workbotChat: null, canRemove: false, disconnectedAt: null, canDisconnect: true,
  organization: { id: "org_1", name: "Fieldnotes Studio" }, owner: { memberId: "mem_alex", name: "Alex Morgan", email: "alex@example.com", former: false }, shared: false,
  externalId: "install-1", removedAt: null, recentProblems: 0, lastEvent: null,
};
const older: OrganizationComputer = { ...desktop, id: "rdv_mac_old", createdAt: "2026-09-21T12:00:00Z", availability: "offline", lastSeenAt: "2026-10-28T12:00:00Z", appVersion: "0.18.40", canDisconnect: true };
const disconnected: OrganizationComputer = { ...desktop, id: "rdv_cut", label: "Riley's Windows laptop", platform: "win32", availability: "offline", disconnectedAt: "2026-11-09T09:00:00Z", canDisconnect: false, canRemove: true,
  owner: { memberId: "mem_riley", name: "Riley Chen", email: "riley@example.com", former: false } };
const former: OrganizationComputer = { ...desktop, id: "rdv_gone", label: "Old iMac", availability: "offline", lastSeenAt: null, appVersion: null, canDisconnect: false, canRemove: true,
  owner: { memberId: "mem_gone", name: null, email: "retired-duplicate-usr_01HZX@deleted.invalid", former: true } };
const shared: OrganizationComputer = { ...desktop, id: "rdv_shared", kind: "vm", provider: "mac_host", source: "manual", label: "Studio shared Mac", availability: "unknown", state: "unknown",
  lastSeenAt: null, appVersion: null, computerId: null, canDisconnect: false, canRemove: true, owner: null, shared: true };
const needsSetup: OrganizationComputer = { ...desktop, id: "rdv_setup", label: "Casey's laptop", availability: "needs_setup", state: "setup_required", statusDetail: "Screen Recording is off", appVersion: "1.4.9",
  owner: { memberId: "mem_casey", name: "Casey Rivera", email: "casey@example.com", former: false } };

const all = [desktop, older, disconnected, former, shared, needsSetup];
const render = (devices: OrganizationComputer[] = all, openId = "") => renderToStaticMarkup(<TeamComputerRows devices={devices} now={now} openId={openId} onToggle={() => {}}
  action={(device) => <span data-stub-menu={device.id} />} detail={(device) => <div data-stub-detail={device.id}>Detail of {device.label}</div>} />);

test("fixtures are computers as Den lists them", () => {
  const parsed = organizationComputerListResponseSchema.safeParse({ devices: all, total: 6, online: 2, staleHidden: 0, page: 1, pageSize: 50, instances: [], instancesTotal: 0, instancePage: 1, instancePageSize: 50 });
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("each computer is one row: what it is, its owner, status, last contact and short version, under quiet column labels", () => {
  const html = render();
  assert.match(text(html), /Computer Owner Status Last contact App version/);
  assert.match(text(row(html, "rdv_mac")), /Alex's MacBook Pro Mac Added 3 Nov A Alex Morgan Online 2 min ago 0\.18\.66 alpha/);
  assert.match(text(row(html, "rdv_setup")), /Casey's laptop Mac C Casey Rivera Needs setup Screen Recording is off 2 min ago 1\.4\.9/);
  // One element per computer carries the row id a person, or a test, presses.
  assert.equal(html.match(/data-testid="computer-row-/g)?.length, 6);
  assert.equal(html.match(/aria-expanded="false"/g)?.length, 6);
  // A list, not a data grid drawn with a table element, and no cards.
  assert.doesNotMatch(html, /<table|<td|rounded-2xl|shadow/);
  assert.match(html, /role="table" aria-label="Computers"/);
  // The build of a version stays out of the list, and on hover.
  assert.doesNotMatch(text(html), /4137|053df1c/);
  assert.match(row(html, "rdv_mac"), /title="0\.18\.66-alpha\.4137\+053df1c"/);
  assert.match(row(html, "rdv_mac"), /<time[^>]*title="[^"]+"[^>]*>2 min ago<\/time>/);
});

test("computers of one owner that share a name say when each was added; a name used once says nothing more", () => {
  const html = render();
  assert.match(text(row(html, "rdv_mac")), /Mac Added 3 Nov/);
  assert.match(text(row(html, "rdv_mac_old")), /Alex's MacBook Pro Mac Added 21 Sep A Alex Morgan Offline 13 days ago 0\.18\.40/);
  assert.doesNotMatch(text(row(html, "rdv_setup")), /Added/);
  assert.doesNotMatch(text(render([desktop, { ...older, owner: { memberId: "mem_other", name: "Omar", email: "omar@example.com", former: false } }])), /Added/);
});

test("a disconnected computer reads Disconnected in neutral ink with how to reconnect, not as an error", () => {
  const cut = row(render(), "rdv_cut");
  assert.match(text(cut), /Riley's Windows laptop Windows PC R Riley Chen Disconnected Sign in on it again to reconnect/);
  assert.match(cut, /data-status="disconnected"/);
  assert.doesNotMatch(cut, /Offline|ow-danger|text-red|bg-red|ow-warning/);
});

test("a former member is named as that, never by a placeholder address; a shared computer says it is shared", () => {
  const html = render();
  assert.match(text(row(html, "rdv_gone")), /Old iMac Mac Former member Offline Never Not reported/);
  assert.doesNotMatch(html, /deleted\.invalid|retired-duplicate/);
  assert.match(text(row(html, "rdv_shared")), /Studio shared Mac Mac sandbox Shared with your organization Not checked yet Never Not reported/);
  // The owner's real address is a tooltip on their lane, not text in the row.
  assert.match(row(html, "rdv_mac"), /title="alex@example\.com"/);
  assert.doesNotMatch(text(html), /alex@example\.com/);
});

test("the open row is marked and shows its detail under it; the others stay closed", () => {
  const html = render([desktop, needsSetup], "rdv_setup");
  assert.equal(html.match(/aria-expanded="true"/g)?.length, 1);
  assert.match(html, /aria-expanded="true" aria-controls="computer-detail-region-rdv_setup"/);
  assert.match(html, /id="computer-detail-region-rdv_setup"[^>]*><div data-stub-detail="rdv_setup">/);
  assert.doesNotMatch(html, /data-stub-detail="rdv_mac"/);
  assert.equal(html.match(/data-stub-menu=/g)?.length, 2);
});

const noActions: ComputerActionSet = {
  actions: [], name: "Alex's MacBook Pro", disconnectConfirm: disconnectOwnConfirm("x"), removeConfirm: removeConfirm("x"),
  onDisconnect: async () => {}, onRemove: async () => {},
};

test("a row with nothing to do has no menu; a connected desktop shows a lock to someone without the permission", () => {
  const locked = renderToStaticMarkup(<TeamComputerControl device={{ ...desktop, canDisconnect: false }} set={noActions} canDisconnectComputers={false} />);
  assert.match(locked, /data-testid="computer-locked-rdv_mac"/);
  assert.match(text(locked.replace(/aria-label="([^"]+)"/, ">$1<")), /Needs the “Disconnect team computers” permission\./);
  assert.equal(renderToStaticMarkup(<TeamComputerControl device={{ ...desktop, canDisconnect: false }} set={noActions} canDisconnectComputers />), "");
  assert.equal(renderToStaticMarkup(<TeamComputerControl device={{ ...shared, canRemove: false }} set={noActions} canDisconnectComputers={false} />), "");
});

test("the line under the list offers the computers not heard from in 30 days, and the way back", () => {
  assert.equal(renderToStaticMarkup(<StaleComputersLine hidden={0} shown={false} onShow={() => {}} onHide={() => {}} />), "");
  const hidden = renderToStaticMarkup(<StaleComputersLine hidden={11} shown={false} onShow={() => {}} onHide={() => {}} />);
  assert.match(text(hidden), /11 not heard from in 30 days Show/);
  assert.match(hidden, /<button[^>]*data-testid="computers-show-stale"/);
  const shown = renderToStaticMarkup(<StaleComputersLine hidden={0} shown onShow={() => {}} onHide={() => {}} />);
  assert.match(text(shown), /Showing computers not heard from in 30 days Hide/);
  assert.match(shown, /<button[^>]*data-testid="computers-hide-stale"/);
});

test("the page header is the title, one line of state and how to add a computer", () => {
  const html = renderToStaticMarkup(<ComputersPageHeader title="Computers" state="6 of 17 online" refreshing={false} onRefresh={() => {}} onAdd={() => {}} />);
  assert.equal(html.match(/<h1/g)?.length, 1);
  assert.match(html, /<h1[^>]*>Computers<\/h1>/);
  assert.match(text(html), /Computers 6 of 17 online Add a computer/);
  assert.match(html, /<button[^>]*aria-label="Refresh"/);
  assert.doesNotMatch(html, /<details|<summary/);
  // While the list loads the state line is a placeholder, not a guess.
  assert.doesNotMatch(text(renderToStaticMarkup(<ComputersPageHeader title="My Computers" state={null} refreshing onRefresh={() => {}} onAdd={() => {}} />)), /online|No computers/);
});
