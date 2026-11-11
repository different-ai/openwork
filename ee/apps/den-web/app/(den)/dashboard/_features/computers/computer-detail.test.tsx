import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { organizationComputerDetailResponseSchema } from "@openwork/types/den/remote-devices";
import { ComputerDetailView } from "./computer-detail";

const now = Date.parse("2026-11-10T12:00:00Z");
const reported = "2026-11-10T11:58:00Z";
const desktop = organizationComputerDetailResponseSchema.parse({
  device: {
    id: "rdv_desktop1", kind: "desktop", provider: "openwork_desktop", source: "desktop_app", platform: "darwin", label: "Design laptop",
    availability: "needs_setup", state: "setup_required", statusDetail: "Screen Recording is off", lastSeenAt: reported, createdAt: reported,
    appVersion: "0.14.2", computerId: "cmp_install1", workbotChat: null,
    organization: { id: "org_example", name: "Example" }, owner: { memberId: "mem_alex", name: "Alex", email: "alex@example.com" }, shared: false,
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
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("computer detail renders supported inventory without platform navigation or raw JSON", () => {
  const html = renderToStaticMarkup(<ComputerDetailView detail={desktop} now={now} standalone />);
  const plain = text(html);
  assert.match(plain, /Owner Alex Availability Needs setup/);
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
