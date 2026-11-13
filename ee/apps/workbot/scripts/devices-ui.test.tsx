import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RemoteDevice } from "@openwork/types/den/remote-devices";
import { deviceGroups, deviceStatusLine, WorkbotDevices } from "../../../packages/workbot-ui/src/devices";
import { DesktopNavigation, type NavigationProps } from "../../../packages/workbot-ui/src/navigation";
import { setWorkbotHost, type WorkbotHost } from "../../../packages/workbot-ui/src/host";

const identity = { organizationId: "fixture-org", principalId: "fixture-member" };
const key = ["workbot", "devices", identity.organizationId, identity.principalId];
const host = (flags: Partial<WorkbotHost> = {}): WorkbotHost => ({
  identity, user: null, homeHref: "/", appIcons: () => [], useConnectedApps: () => [],
  requestJson: async () => { throw new Error("Rendering must not ask for anything"); },
  prepare: async () => { throw new Error("Rendering must not prepare a request"); },
  ...flags,
});
const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const device = (id: string, label: string, extra: Partial<RemoteDevice> = {}): RemoteDevice => ({
  id, kind: "desktop", provider: "openwork_desktop", source: "desktop_app", platform: "darwin", label, access: "mine", availability: "online", state: "ready",
  statusDetail: null, lastSeenAt: ago(60_000), createdAt: "2026-01-01T00:00:00.000Z", appVersion: "1.0.0", computerId: null, workbotChat: null, canRename: true, canRemove: true, ...extra,
});
const fixture: RemoteDevice[] = [
  device("d1", "Ada's MacBook Pro", { computerId: "computer_1" }),
  device("d2", "Studio PC", { platform: "win32", availability: "needs_setup", state: "setup_required", statusDetail: "Screen Recording is off" }),
  device("d3", "Old laptop", { platform: "linux", availability: "offline", lastSeenAt: ago(2 * 60 * 60_000 + 5_000) }),
  device("v1", "Workbot's computer", { kind: "vm", provider: "workbot", source: "workbot", platform: "linux", workbotChat: "main", availability: "paused", state: "paused", lastSeenAt: ago(3 * 24 * 60 * 60_000), canRename: false, canRemove: false }),
  device("v2", "Research chat", { kind: "vm", provider: "workbot", source: "workbot", platform: "linux", workbotChat: "sidechat0devices01", canRename: false, canRemove: false }),
  device("v3", "Build sandbox", { kind: "vm", provider: "mac_host", source: "manual", access: "shared", availability: "unknown", state: "unknown", lastSeenAt: null }),
];

function render(flags: Partial<WorkbotHost>, seed: (client: QueryClient) => void | Promise<void>, computerFor?: (chat: string) => (() => void) | null) {
  setWorkbotHost(host({ devices: true, ...flags }));
  // A static render stands for the page as it is, not for the moment before its next read: a failed read stays failed.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  return Promise.resolve(seed(client)).then(() => {
    try { return renderToStaticMarkup(<QueryClientProvider client={client}><WorkbotDevices computerFor={computerFor} /></QueryClientProvider>); }
    finally { client.clear(); }
  });
}
const rows = (html: string) => html.split("<li ").slice(1);
const rowOf = (html: string, label: string) => rows(html).find(entry => entry.includes(`>${label}<`)) ?? "";

test("Devices is a destination only where it is on for the person", () => {
  const props: NavigationProps = { page: "home", onPage: () => {}, onProfile: () => {}, currentChat: null, chats: undefined, loading: false, failed: false, onRetry: () => {}, drafts: false };
  const navigation = (flags: Partial<WorkbotHost>, page: NavigationProps["page"] = "home") => {
    setWorkbotHost(host({ documents: true, calendar: true, ...flags }));
    return renderToStaticMarkup(<DesktopNavigation {...props} page={page} />);
  };
  const on = navigation({ devices: true });
  assert.ok(on.includes('aria-label="Devices"'));
  assert.ok(on.indexOf('aria-label="Calendar"') < on.indexOf('aria-label="Devices"'), "after Calendar");
  assert.ok(!/aria-label="Devices"[^>]*aria-current/.test(on) && !/aria-current="page"[^>]*aria-label="Devices"/.test(on));
  const current = navigation({ devices: true }, "devices");
  assert.ok(/<button[^>]*aria-label="Devices"[^>]*aria-current="page"|<button[^>]*aria-current="page"[^>]*aria-label="Devices"/.test(current), "marked as the page on screen");
  assert.ok(!navigation({}).includes("Devices"), "absent means off");
  assert.ok(!navigation({ devices: false }).includes("Devices"));
  assert.ok(!navigation({ devices: true, profileComputers: true }).includes('aria-label="Devices"'), "the profile owns Computers without a redundant standalone entry");
  assert.ok(navigation({ devices: true, profileComputers: false }).includes('aria-label="Devices"'), "turning off the move restores the old entry");
});

test("the list names each computer, what it is and whether it can be reached", async () => {
  const opened: string[] = [];
  const html = await render({ computer: true, browser: true }, client => { client.setQueryData(key, fixture); },
    chat => (chat === "main" ? () => { opened.push(chat); } : null));
  assert.ok(html.indexOf(">Your computers<") > 0 && html.indexOf(">Your computers<") < html.indexOf(">Cloud computers<"), "two plain group labels, the person's own first");
  assert.deepEqual(deviceGroups(fixture).map(group => group.devices.map(entry => entry.id)), [["d1", "d2", "d3"], ["v1", "v2", "v3"]]);
  assert.equal(rows(html).length, 6);

  const mac = rowOf(html, "Ada&#x27;s MacBook Pro");
  assert.ok(mac.includes(">Mac<") && mac.includes(">Online<") && mac.includes(">Active now<"));
  assert.ok(mac.includes("Takes tasks from Workbot") && mac.includes("--wb-status-online") && mac.includes("lucide-laptop"));
  const pc = rowOf(html, "Studio PC");
  assert.ok(pc.includes(">Windows PC<") && pc.includes(">Needs setup<") && pc.includes(">Screen Recording is off<") && pc.includes("--wb-status-attention"));
  assert.ok(!pc.includes("Takes tasks from Workbot"), "only a desktop that takes remote tasks says so");
  const old = rowOf(html, "Old laptop");
  assert.ok(old.includes(">Linux computer<") && old.includes(">Offline<") && old.includes(">2 hours ago<") && old.includes("--wb-disabled"));
  const main = rowOf(html, "Workbot&#x27;s computer");
  assert.ok(main.includes(">Paused<") && main.includes(">3 days ago<") && main.includes(">Open</button>"), "Workbot's own computer opens from its row");
  assert.ok(!rowOf(html, "Research chat").includes("<button"), "no Open where that chat's computer can't be opened from here");
  const sandbox = rowOf(html, "Build sandbox");
  assert.ok(sandbox.includes(">Mac sandbox<") && sandbox.includes(">Shared with your organization<") && sandbox.includes(">Not checked yet<") && sandbox.includes("lucide-cloud"));
  assert.ok(!sandbox.includes("<button") && !/ago</.test(sandbox), "a computer never heard from shows no time, and only Workbot's computers open here");
  assert.equal(html.match(/>Open<\/button>/g)?.length, 1, "at most one action on a row, and only where it works");
  assert.ok(html.includes("Add or remove computers in OpenWork Desktop, under Settings › Devices."));
  for (const id of fixture.map(entry => entry.id)) assert.ok(!html.includes(`>${id}<`) && !html.includes(`"${id}"`), "ids are never shown");
  assert.deepEqual(opened, [], "rendering opens nothing");
});

test("Open needs computer access, task-capable desktops always show their marker, and one group needs no label", async () => {
  const cloudOnly = fixture.filter(entry => entry.kind === "vm");
  const html = await render({}, client => { client.setQueryData(key, cloudOnly); }, () => () => {});
  assert.ok(!html.includes("<button"), "neither the Browser nor the Computer view: nothing to open");
  assert.ok(!html.includes("Cloud computers") && !html.includes("Your computers"), "a single group is just the list");
  const desktops = await render({ browser: true }, client => { client.setQueryData(key, fixture.filter(entry => entry.kind === "desktop")); }, () => () => {});
  assert.ok(desktops.includes("Takes tasks from Workbot") && !desktops.includes("<button"));
  assert.ok((await render({ browser: true }, client => { client.setQueryData(key, cloudOnly); }, () => () => {})).includes("Open Workbot&#x27;s browser"));
});

test("when a computer was last heard from reads as a person would say it", () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  const line = (extra: Partial<RemoteDevice>) => deviceStatusLine(device("x", "X", { availability: "offline", ...extra }), NOW);
  assert.equal(line({ availability: "online", lastSeenAt: at(30_000) }), "Active now");
  assert.equal(line({ lastSeenAt: at(20_000) }), "Just now");
  assert.equal(line({ lastSeenAt: at(61_000) }), "1 minute ago");
  assert.equal(line({ lastSeenAt: at(45 * 60_000) }), "45 minutes ago");
  assert.equal(line({ lastSeenAt: at(60 * 60_000) }), "1 hour ago");
  assert.equal(line({ lastSeenAt: at(26 * 60 * 60_000) }), "1 day ago");
  assert.equal(line({ lastSeenAt: at(90 * 24 * 60 * 60_000) }), "Dec 10, 2025");
  assert.equal(line({ lastSeenAt: null }), null);
  assert.equal(line({ availability: "online", statusDetail: "Accessibility is off" }), "Accessibility is off", "what needs attention comes first");
});

test("loading, empty and failed each say so in the list's own place", async () => {
  const loading = await render({}, () => {});
  assert.ok(loading.includes('aria-busy="true"') && loading.includes("data-workbot-devices-loading") && !loading.includes("Loading…"));
  assert.equal(rows(loading).length, 3, "three rows shaped like the list");

  const empty = await render({}, client => { client.setQueryData(key, []); });
  assert.ok(empty.includes(">No computers yet<"));
  assert.ok(empty.includes("Sign in to OpenWork Desktop on a computer, or let Workbot use its own computer, and it shows up here."));
  assert.ok(!empty.includes("<li") && !empty.includes("<button"));

  const fail = (client: QueryClient) => client.prefetchQuery({ queryKey: key, queryFn: async () => { throw new Error("Couldn't load your computers."); }, retry: false, staleTime: 0 });
  const failed = await render({}, fail);
  assert.ok(failed.includes("load your computers<") && failed.includes(">Try again</button>") && !failed.includes("<li"));

  const stale = await render({}, async client => { client.setQueryData(key, fixture.slice(0, 1)); await fail(client); });
  assert.ok(stale.includes("Ada&#x27;s MacBook Pro"), "the last good list stays");
  assert.ok(stale.includes("load your computers.") && stale.includes(">Try again</button>"));
});
