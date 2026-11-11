import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteDevice, RemoteDeviceEvent } from "@openwork/types/den/remote-devices";
import { MyComputerActivity, MyComputersTable } from "./my-computers-screen";
import { myComputersQueryKey } from "./my-computers-data";

const now = Date.parse("2026-11-10T12:10:00Z");
const base: RemoteDevice = {
  id: "rdv_mine", kind: "desktop", provider: "openwork_desktop", source: "desktop_app", platform: "darwin", label: "Work laptop",
  access: "mine", availability: "online", state: "ready", statusDetail: null, lastSeenAt: "2026-11-10T12:08:00Z", createdAt: "2026-11-01T09:00:00Z",
  appVersion: "1.5.2", computerId: null, workbotChat: null, canRename: false, canRemove: true,
};
const shared: RemoteDevice = {
  ...base, id: "rdv_shared", kind: "vm", provider: "mac_host", source: "manual", label: "Studio Mac", access: "shared",
  availability: "unknown", state: "unknown", lastSeenAt: null, appVersion: null, canRemove: false,
};
const needsSetup: RemoteDevice = { ...base, id: "rdv_setup", platform: "win32", label: "Home PC", availability: "needs_setup", state: "setup_required", statusDetail: "Computer use needs setup" };

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("a member's computers show what each is, whose it is, its state, last contact and version", () => {
  const html = renderToStaticMarkup(<MyComputersTable devices={[base, needsSetup, shared]} now={now} openId="" onToggle={() => {}} detail={() => null} />);
  const page = text(html);
  assert.match(page, /Computer.*Belongs to.*Availability.*Last contact.*App version/);
  assert.match(page, /Work laptop Mac You Online 2 min ago 1\.5\.2/);
  assert.match(page, /Home PC Windows PC You Needs setup Computer use needs setup/);
  assert.match(page, /Studio Mac Mac sandbox Shared with your organization Not checked yet Never Not reported/);
  // View only, and nothing an admin would need: no ids, owners' emails, rename or remove.
  assert.doesNotMatch(html, /rdv_[a-z]+<|Rename|Remove|@/);
  assert.equal(html.match(/aria-expanded="false"/g)?.length, 3);
});

test("opening a computer shows its recent activity in plain sentences, without codes", () => {
  const events: RemoteDeviceEvent[] = [
    { id: "rde_2", type: "state_changed", level: "warning", message: "Needs setup: Screen Recording is off", actor: "device", createdAt: "2026-11-10T12:05:00Z" },
    { id: "rde_1", type: "registered", level: "info", message: "Signed in on OpenWork 1.5.2", actor: "device", createdAt: "2026-11-10T09:00:00Z" },
  ];
  const html = renderToStaticMarkup(<MyComputersTable devices={[base]} now={now} openId="rdv_mine" onToggle={() => {}} detail={() => <MyComputerActivity events={events} now={now} />} />);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /id="my-computer-activity-rdv_mine"/);
  const page = text(html);
  assert.match(page, /Needs setup: Screen Recording is off 5 min ago/);
  assert.match(page, /Signed in on OpenWork 1\.5\.2 3 hours ago/);
  assert.doesNotMatch(page, /state_changed|registered|rde_/);
  assert.match(text(renderToStaticMarkup(<MyComputerActivity events={[]} now={now} />)), /Nothing recorded yet\./);
});

test("the list is cached per organization and member, never shared between them", () => {
  assert.notDeepEqual(myComputersQueryKey("org_a", "om_1"), myComputersQueryKey("org_a", "om_2"));
  assert.notDeepEqual(myComputersQueryKey("org_a", "om_1"), myComputersQueryKey("org_b", "om_1"));
});
