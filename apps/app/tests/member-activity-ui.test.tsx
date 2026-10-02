import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { ActivityContext, ActivityResource, MemberActivityEntry } from "../src/react-app/kernel/activity-types";

GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const reload = mock(async () => {});
const reloadCoordinator = await import("../src/react-app/shell/reload-coordinator");
mock.module("../src/react-app/shell/reload-coordinator", () => ({
  ...reloadCoordinator,
  useReloadCoordinator: () => ({ reloadWorkspaceEngine: reload }),
}));

const { NotificationBell } = await import("../src/react-app/shell/notification-center");
const { ActivityPage } = await import("../src/react-app/domains/activity/activity-page");
const { ShellConfigProvider } = await import("../src/react-app/shell/shell-config");
const { TooltipProvider } = await import("../src/components/ui/tooltip");
const { useActivityStore } = await import("../src/react-app/kernel/activity-store");
const { ACTIVITY_REFRESH_EVENT } = await import("../src/react-app/kernel/activity-types");
const { useNotificationStore } = await import("../src/react-app/kernel/notification-store");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  useActivityStore.setState({ activeScopeKey: null, contexts: {}, refreshState: "idle" });
  useNotificationStore.setState({ notifications: [] });
  reload.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  await GlobalRegistrator.unregister();
});

function Location() { return <output data-location>{useLocation().pathname}</output>; }

async function render(onTrySkill?: (resource: ActivityResource) => void) {
  await act(async () => root.render(
    <MemoryRouter><ShellConfigProvider><TooltipProvider>
      <Location />
      <NotificationBell />
      <Routes>
        <Route path="/" element={<div>Session</div>} />
        <Route path="/activity" element={<ActivityPage onTrySkill={onTrySkill} />} />
        <Route path="/extensions/*" element={<div>Library</div>} />
        <Route path="/settings/*" element={<div>Settings destination</div>} />
      </Routes>
    </TooltipProvider></ShellConfigProvider></MemoryRouter>,
  ));
}

function bell() {
  const result = document.querySelector<HTMLButtonElement>("[data-notification-bell]");
  if (!result) throw new Error("Missing Activity bell");
  return result;
}

async function toggleBell() {
  await act(async () => bell().click());
}

async function viewAll() {
  await act(async () => button("View all").click());
}

function button(label: string) {
  const result = Array.from(document.querySelectorAll("button"))
    .find((element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

function resource(id: string, kind: ActivityResource["kind"], label: string): ActivityResource {
  return { id, kind, label, revision: "1", href: kind === "provider" ? "/settings/ai" : `/extensions/${id}` };
}

function seed(
  entries: MemberActivityEntry[],
  resources = entries.filter((entry) => entry.change !== "unavailable").map((entry) => entry.resource),
  extra: Partial<ActivityContext> = {},
) {
  const context: ActivityContext = {
    entries,
    snapshots: {
      providers: resources.filter((item) => item.kind === "provider"),
      capabilities: resources.filter((item) => item.kind === "skill" || item.kind === "plugin"),
      connections: resources.filter((item) => item.kind === "connection"),
    },
    verifiedAt: Date.now(),
    ...extra,
  };
  useActivityStore.setState({ activeScopeKey: "member-fixture", contexts: { "member-fixture": context }, refreshState: "idle" });
}

test("an empty Activity popover is the quiet A4 state, and the page offers the Library", async () => {
  await render();
  await toggleBell();
  const panel = document.querySelector("[data-notification-panel]");
  expect(panel?.textContent).toContain("Nothing new");
  expect(panel?.textContent).toContain("When something is shared with you or changes, it shows here.");
  expect(panel?.textContent).not.toContain("View all");
  expect(document.querySelector("[data-notification-unread]")).toBeNull();
  expect(document.querySelector("[data-activity-loading]")).toBeNull();
  // A4 has no View all; the page is still a route of its own.
  await act(async () => root.render(
    <MemoryRouter key="page" initialEntries={["/activity"]}><ShellConfigProvider><TooltipProvider>
      <Location />
      <Routes>
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/extensions/*" element={<div>Library</div>} />
      </Routes>
    </TooltipProvider></ShellConfigProvider></MemoryRouter>,
  ));
  for (const filter of ["All", "Skills", "Plugins", "Connections"]) expect(button(filter)).toBeTruthy();
  expect(Array.from(document.querySelectorAll("button")).some((element) => element.textContent === "Models")).toBe(false);
  expect(container.textContent).toContain("Nothing new");
  await click("Browse Library");
  expect(container.querySelector("[data-location]")?.textContent).toBe("/extensions");
});

test("first verification with nothing shared replaces Nothing new with one state line and Browse Library", async () => {
  seed([], [], { baseline: { observedAt: Date.now() - 1_000, labels: [] } });
  await render();
  await toggleBell();
  const panel = document.querySelector("[data-notification-panel]");
  expect(panel?.textContent).toContain("Nothing shared with you yet");
  expect(panel?.textContent).not.toContain("Nothing new");
  const library = panel?.querySelector<HTMLAnchorElement>("[data-activity-nothing-shared] a");
  expect(library?.textContent).toBe("Browse Library");
  await act(async () => library?.click());
  expect(container.querySelector("[data-location]")?.textContent).toBe("/extensions");
  expect(bell().getAttribute("aria-expanded")).toBe("false");
});

test("existing access is summarized as one baseline row with an Open Library action", async () => {
  const observedAt = Date.now() - 60_000;
  seed([], [], { baseline: { observedAt, labels: ["Proposal writer", "Weekly report", "Google Calendar", "Sales playbook"] } });
  await render();
  expect(document.querySelector("[data-notification-unread]")).toBeNull();
  await toggleBell();
  const panel = document.querySelector("[data-notification-panel]");
  expect(panel?.textContent).toContain("You’re caught up");
  expect(panel?.textContent).toContain("4 things were already shared with you");
  await viewAll();
  const row = container.querySelector('[data-activity-row="baseline"]');
  expect(row?.textContent).toContain("4 things were already shared with you");
  expect(row?.textContent).toContain("Proposal writer, Weekly report, Google Calendar and 1 more");
  expect(row?.querySelector("a")?.textContent).toBe("Open Library");
});

test("member rows use actorless design copy, design actions, filters, day groups and the no-matches row", async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  const skill: ActivityResource = { ...resource("briefing", "skill", "Customer briefing"), pluginName: "Customer toolkit", skillSlug: "customer-briefing", capability: "plugin:toolkit:briefing", marketplaceName: "Company" };
  const plugin: ActivityResource = { ...resource("playbook", "plugin", "Sales playbook"), marketplaceName: "Company", skillCount: 4 };
  seed([
    { id: "skill-shared", resource: skill, change: "available", observedAt: Date.now() - 1_000 },
    { id: "skill-updated", resource: { ...resource("summary", "skill", "Proposal writer"), pluginName: "Customer toolkit" }, change: "updated", observedAt: Date.now() - 2_000 },
    { id: "plugin-added", resource: plugin, change: "available", observedAt: Date.now() - 3_000 },
    { id: "connection-ready", resource: resource("calendar", "connection", "Google Calendar"), change: "available", observedAt: Date.now() - 4_000 },
    { id: "skill-removed", resource: resource("checklist", "skill", "Onboarding checklist"), change: "unavailable", observedAt: yesterday.getTime() },
  ]);
  const tried: ActivityResource[] = [];
  await render((item) => tried.push(item));
  await toggleBell();
  const panel = document.querySelector("[data-notification-panel]");
  expect(panel?.textContent).toContain("Customer briefing shared with you");
  expect(panel?.textContent).toContain("Proposal writer updated");
  expect(panel?.textContent).toContain("Sales playbook added to Company");
  expect(panel?.textContent).toContain("Google Calendar ready to use");
  expect(panel?.textContent).toContain("Onboarding checklist removed");
  expect(panel?.querySelector("time")?.getAttribute("aria-label")).toStartWith("Observed on this device");
  await viewAll();
  expect(container.textContent).toContain("Today");
  expect(container.textContent).toContain("Yesterday");
  const row = (id: string) => container.querySelector(`[data-activity-row="${id}"]`);
  expect(row("skill-shared")?.textContent).toContain("Customer briefing was shared with you");
  expect(row("skill-shared")?.textContent).toContain("Skill in Customer toolkit");
  expect(row("skill-updated")?.textContent).toContain("A new version of Proposal writer was published");
  expect(row("plugin-added")?.textContent).toContain("Sales playbook was added to the Company marketplace");
  expect(row("plugin-added")?.textContent).toContain("Plugin with 4 skills");
  expect(row("plugin-added")?.querySelector("a")?.textContent).toBe("Browse");
  expect(row("connection-ready")?.textContent).toContain("Google Calendar is ready to use");
  expect(row("connection-ready")?.textContent).toContain("Connected by your organization");
  expect(row("connection-ready")?.querySelector("a")?.textContent).toBe("Open");
  const removed = row("skill-removed");
  expect(removed?.textContent).toContain("Onboarding checklist is no longer shared with you");
  expect(removed?.getAttribute("data-unavailable")).toBe("true");
  expect(removed?.querySelector("a, button")).toBeNull();
  expect(removed?.querySelector("[data-activity-ask-admin]")?.textContent).toBe("Ask an admin");
  await click("Try Customer briefing in a new session");
  expect(tried).toEqual([skill]);
  await click("Connections");
  expect(container.textContent).toContain("Google Calendar is ready to use");
  expect(container.textContent).not.toContain("Customer briefing");
  seed([{ id: "skill-shared", resource: skill, change: "available", observedAt: Date.now() - 1_000 }]);
  await act(async () => {});
  expect(container.querySelector("[data-activity-no-matches]")?.textContent).toContain("No connection changes in the last 30 days");
  await click("Show all activity");
  expect(container.textContent).toContain("Customer briefing was shared with you");
});

test("a past share for a resource that is gone later has no action and no lock; only the removal is muted", async () => {
  const calendar = resource("calendar", "connection", "Work calendar");
  seed([
    { id: "connection-removed", resource: calendar, change: "unavailable", observedAt: Date.now() - 1_000 },
    { id: "connection-added", resource: calendar, change: "available", observedAt: Date.now() - 2_000 },
  ], []);
  await render();
  await toggleBell();
  await viewAll();
  const added = container.querySelector('[data-activity-row="connection-added"]');
  expect(added?.getAttribute("data-unavailable")).toBeNull();
  expect(added?.querySelector("a, button, [data-activity-ask-admin]")).toBeNull();
  expect(container.querySelector('[data-activity-row="connection-removed"]')?.getAttribute("data-unavailable")).toBe("true");
});

test("unread rows carry a dot until the popover closes; then the popover says You’re caught up", async () => {
  const observedAt = Date.now() - 5_000;
  seed([
    { id: "skill-new", resource: resource("summary", "skill", "Summarize notes"), change: "available", observedAt },
    { id: "skill-old", resource: resource("older", "skill", "Older skill"), change: "available", observedAt: observedAt - 60_000 },
  ], undefined, { seenAt: observedAt - 1_000 });
  await render();
  expect(document.querySelector("[data-notification-unread]")).not.toBeNull();
  expect(bell().getAttribute("aria-label")).toBe("Activity, 1 unread");
  await toggleBell();
  const panel = document.querySelector("[data-notification-panel]");
  expect(panel?.querySelector('[data-activity-row="skill-new"] [data-activity-unread]')).not.toBeNull();
  expect(panel?.querySelector('[data-activity-row="skill-old"] [data-activity-unread]')).toBeNull();
  const history = JSON.stringify(Object.values(useActivityStore.getState().contexts)[0]?.entries);
  await toggleBell();
  expect(document.querySelector("[data-notification-unread]")).toBeNull();
  expect(bell().getAttribute("aria-label")).toBe("Activity");
  expect(JSON.stringify(Object.values(useActivityStore.getState().contexts)[0]?.entries)).toBe(history);
  await toggleBell();
  const caughtUp = document.querySelector("[data-notification-panel]");
  expect(caughtUp?.textContent).toContain("You’re caught up");
  expect(caughtUp?.textContent).toContain("Earlier");
  expect(caughtUp?.querySelectorAll("[data-activity-unread]").length).toBe(0);
});

test("compact member rows navigate as one link and close Activity; removed rows stay noninteractive", async () => {
  seed([
    { id: "model-added", resource: resource("model", "provider", "Research models"), change: "available", observedAt: Date.now() - 1_000 },
    { id: "skill-updated", resource: resource("summary", "skill", "Summarize notes"), change: "updated", observedAt: Date.now() - 2_000 },
    { id: "connection-removed", resource: resource("calendar", "connection", "Work calendar"), change: "unavailable", observedAt: Date.now() - 3_000 },
  ]);
  await render();
  expect(bell().getAttribute("aria-expanded")).toBe("false");
  await toggleBell();
  const panel = document.querySelector("[data-notification-panel]");
  const destination = panel?.querySelector<HTMLAnchorElement>('[data-activity-row="skill-updated"] a');
  expect(destination?.getAttribute("href")).toBe("/extensions/summary");
  expect(destination?.getAttribute("aria-label")).toBe("Open Summarize notes");
  expect(destination?.textContent).toContain("Summarize notes updated");
  expect(destination?.querySelector("button, a, [tabindex='0']")).toBeNull();
  expect(destination?.querySelector("time")?.getAttribute("title")).toStartWith("Observed on this device");
  expect(panel?.querySelectorAll('[data-activity-row="skill-updated"] a, [data-activity-row="skill-updated"] button').length).toBe(1);
  const unavailable = panel?.querySelector('[data-activity-row="connection-removed"]');
  expect(unavailable?.querySelector("a, button, [tabindex='0']")).toBeNull();
  expect(unavailable?.getAttribute("data-unavailable")).toBe("true");
  await act(async () => destination?.click());
  expect(container.querySelector("[data-location]")?.textContent).toBe("/extensions/summary");
  expect(bell().getAttribute("aria-expanded")).toBe("false");
  await toggleBell();
  const model = document.querySelector<HTMLAnchorElement>('[data-notification-panel] [data-activity-row="model-added"] a');
  expect(model?.getAttribute("href")).toBe("/settings/ai");
  await act(async () => model?.click());
  expect(container.querySelector("[data-location]")?.textContent).toBe("/settings/ai");
  expect(bell().getAttribute("aria-expanded")).toBe("false");
});

test("initial scoped refresh shows lane skeletons, failed refresh keeps history with its time and Retry requests fresh verification", async () => {
  useActivityStore.setState({ activeScopeKey: "member-fixture", refreshState: "refreshing" });
  await render();
  await toggleBell();
  expect(document.querySelector("[data-activity-loading]")).not.toBeNull();
  expect(document.querySelector("[data-notification-panel]")?.textContent).not.toContain("Nothing new");
  await act(async () => seed([
    { id: "verified-skill", resource: resource("summary", "skill", "Summarize notes"), change: "updated", observedAt: Date.now() - 1_000 },
  ]));
  await viewAll();
  await act(async () => useActivityStore.setState({ refreshState: "refreshing" }));
  expect(container.querySelector("[data-activity-loading]")).toBeNull();
  expect(container.textContent).toContain("A new version of Summarize notes was published");
  await act(async () => useActivityStore.setState({ refreshState: "error" }));
  expect(container.textContent).toContain("A new version of Summarize notes was published");
  expect(container.querySelector("[data-activity-refresh-error]")?.textContent).toMatch(/^Couldn’t refresh\. Showing activity from .+\.Retry$/);
  const refresh = mock(() => {});
  window.addEventListener(ACTIVITY_REFRESH_EVENT, refresh);
  try {
    await click("Retry");
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener(ACTIVITY_REFRESH_EVENT, refresh);
  }
});

test("device notices such as engine reloads stay out of Activity; only member changes appear", async () => {
  seed(Array.from({ length: 6 }, (_, index) => ({
    id: `skill-${index}`, resource: resource(`skill-${index}`, "skill", `Skill ${index}`), change: "updated", observedAt: Date.now() - (index + 1) * 1_000,
  })), undefined, { seenAt: Date.now() });
  useNotificationStore.getState().add({ kind: "reload", severity: "success", title: "Updates applied", body: "Skill 'preview-my-work' is now active." });
  useNotificationStore.getState().add({ kind: "update", severity: "error", title: "Update check failed" });
  await render();
  expect(document.querySelector("[data-notification-unread]")).toBeNull();
  await toggleBell();
  const panel = document.querySelector("[data-notification-panel]");
  expect(panel?.textContent).not.toContain("Updates applied");
  expect(panel?.textContent).not.toContain("Update check failed");
  expect(panel?.textContent).toContain("You’re caught up");
  await viewAll();
  expect(container.querySelectorAll("[data-activity-row]").length).toBe(6);
  expect(container.textContent).not.toContain("Updates applied");
  expect(container.querySelector('[data-activity-kind="system"]')).toBeNull();
  await act(async () => useActivityStore.setState({ activeScopeKey: null }));
  expect(container.textContent).not.toContain("Skill 0");
  expect(container.textContent).toContain("Nothing new");
});

test("Activity stays hidden when the shell disables notifications", async () => {
  window.localStorage.setItem("openwork.shell-config", JSON.stringify({ notifications: false }));
  await render();
  expect(document.querySelector("[data-notification-bell]")).toBeNull();
});
