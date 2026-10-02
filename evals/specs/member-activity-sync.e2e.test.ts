import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Target } from "@openwork/cdp";
import { memberActivity } from "../worlds/member-activity.ts";

const test = spec.world(memberActivity, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  timeout: 900_000,
});

const bell: Target = { role: "button", label: /^Activity/ };
const retry: Target = { role: "button", label: "Retry" };
const inventoryPaths = [
  "/v1/llm-providers",
  "/v1/inference-providers?scope=usable",
  "/v1/resources/marketplace-capabilities",
  "/v1/me/library",
  "/v1/mcp-connections?scope=usable",
];

type ActivityEntry = {
  id: string;
  change: string;
  observedAt: number;
  resource: { id: string; kind: string; label: string; href: string };
};
type Activity = {
  entries: ActivityEntry[];
  verifiedAt: number | null;
  refreshState: string;
  unreadCount: number;
  baseline: string[] | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activity(value: unknown): Activity {
  if (!record(value) || !Array.isArray(value.entries) || typeof value.refreshState !== "string"
    || (value.verifiedAt !== null && typeof value.verifiedAt !== "number")) throw new Error("Activity query returned an invalid status");
  const entries = value.entries.map((entry): ActivityEntry => {
    if (!record(entry) || !record(entry.resource) || typeof entry.id !== "string"
      || typeof entry.change !== "string" || typeof entry.observedAt !== "number"
      || typeof entry.resource.id !== "string" || typeof entry.resource.kind !== "string"
      || typeof entry.resource.label !== "string" || typeof entry.resource.href !== "string") {
      throw new Error("Activity query returned an invalid entry");
    }
    return {
      id: entry.id, change: entry.change, observedAt: entry.observedAt,
      resource: { id: entry.resource.id, kind: entry.resource.kind, label: entry.resource.label, href: entry.resource.href },
    };
  });
  const baseline = record(value.baseline) && Array.isArray(value.baseline.labels)
    ? value.baseline.labels.filter((label): label is string => typeof label === "string")
    : null;
  return {
    entries, verifiedAt: value.verifiedAt, refreshState: value.refreshState,
    unreadCount: typeof value.unreadCount === "number" ? value.unreadCount : 0, baseline,
  };
}

function signedInAs(value: unknown, email: string): boolean {
  return record(value) && value.status === "signed_in" && record(value.user) && value.user.email === email;
}

function successfulInventoryReads(requests: Array<{ method: string; path: string; status: number }>): string[] {
  return inventoryPaths.filter((path) => requests.some((request) => request.method === "GET" && request.path.endsWith(path) && request.status === 200));
}

test("a member discovers newly shared tools in Activity without seeing another member's history", async ({ world, user, agent, probe, step, evidence }) => {
  const feed = async () => activity(await agent.run("activity.list"));
  // Actorless design copy (Paper A1/A2): compact rows in the popover, full sentences on the page.
  const compact = (name: string): Target => ({ text: new RegExp(`^${name} (?:ready to use|shared with you|added to .+)$`) });
  const available = (name: string): Target => ({ text: new RegExp(`^${name} (?:is ready to use|was shared with you|was added to the .+ marketplace)$`) });
  const alreadyShared: Target = { text: /^\d+ things? (?:was|were) already shared with you$/ };
  const baseline = () => probe.eventually(feed, {
    within: 60_000, label: "member inventory has been verified", until: (value) => value.verifiedAt !== null && value.refreshState === "idle",
  });
  // Navigation can finish before Base UI's exit animation unmounts the panel.
  // Observe removal without sending another close action that could hide a bug.
  const waitForPopoverClosed = () => probe.eventually(() => probe.dom("[data-notification-panel]"), {
    within: 10_000, label: "Activity popover closes", until: (value) => value.elements.length === 0,
  });
  const closePopover = async () => {
    await user.press("Escape");
    await waitForPopoverClosed();
  };
  /** Closing the popover marked everything seen: a quiet bell, no dot, no mark-all control. */
  const caughtUp = async () => {
    await user.see(bell);
    expect((await probe.dom("[data-notification-bell][aria-label='Activity']")).elements).toHaveLength(1);
    expect((await probe.dom("[data-notification-unread]")).elements).toHaveLength(0);
    await user.notSee({ role: "button", label: /Mark all.*read/i });
  };
  let observed: ActivityEntry[] = [];
  let connectionId = "";
  let providerId = "";
  let pluginId = "";

  await step("before: existing access is one quiet summary row, not a burst of changes", async () => {
    const state = await baseline();
    const remote = await world.inventory("recipient");
    expect(remote.connections).toContain(world.baselineId);
    expect(state.entries).toEqual([]);
    expect(state.baseline).toContain(world.names.baseline);
    const reads = successfulInventoryReads(await world.requests());
    expect(reads).toHaveLength(inventoryPaths.length);
    await caughtUp();
    await user.click(bell);
    await user.see({ text: "You’re caught up" });
    await user.see(alreadyShared);
    evidence.recordAssertionEvidence("The first successful inventory is silent", `5 member inventory endpoints returned 200; ${remote.connections.length} existing connections; 0 Activity entries; ${state.baseline?.length} things summarized in one row; no unread indicator`, true);
    await user.screenshot();
    await closePopover();
  });

  await step("Open Library takes the member from the summary to their available tools", async () => {
    await user.click(bell);
    await user.click({ role: "button", label: "View all" });
    await waitForPopoverClosed();
    await user.see(alreadyShared);
    await user.see({ text: /\band \d+ more$|^[^,]+(?:, [^,]+){0,2}$/ });
    await user.click({ role: "link", label: "Open Library" });
    await probe.eventually(() => world.location(), {
      within: 10_000, label: "Library opens from the Activity summary", until: (path) => path.endsWith("/extensions"),
    });
    await user.see({ text: "Library" });
    expect((await feed()).entries).toEqual([]);
    evidence.recordAssertionEvidence("The summary row has a useful destination", `Open Library opens ${await world.location()}; initial access still creates 0 Activity entries`, true);
    await user.screenshot();
    await user.navigate(`${world.app.webUrl}/workspace/${world.workspace.workspaceId}/session`);
  });

  await step("a temporary Cloud outage offers Retry while the member's new tools are being shared", async () => {
    await world.failInventory();
    const publication = await world.publishForRecipient();
    connectionId = publication.connectionId;
    providerId = publication.providerId;
    pluginId = publication.pluginId;
    await user.reload();
    await user.click(bell);
    await user.see(retry, { timeoutMs: 60_000 });
    const failed = await probe.eventually(feed, {
      within: 30_000, label: "inventory failure reaches Activity", until: (value) => value.refreshState === "error",
    });
    const rejected = (await world.requests()).filter((request) => request.path.endsWith("/v1/llm-providers") && request.status === 503);
    expect(rejected.length).toBeGreaterThan(0);
    expect(failed.entries).toEqual([]);
    expect(failed.verifiedAt).not.toBeNull();
    evidence.recordAssertionEvidence("The failed refresh is witnessed at the service boundary", `${rejected.length} inventory requests returned 503; ${publication.statuses.length} administrative writes succeeded; the verified baseline remains and Retry is visible`, true);
    await user.screenshot();
  });

  await step("after: Retry fetches newly shared models, skills, plugins, and connections into compact Activity rows", async () => {
    const beforeRequests = (await world.requests()).length;
    await world.recoverInventory();
    await user.click(retry);
    const synced = await probe.eventually(feed, {
      within: 60_000, label: "real member inventory produces Activity", until: (value) => value.refreshState === "idle"
        && ["provider", "skill", "plugin", "connection"].every((kind) => value.entries.some((entry) => entry.resource.kind === kind)),
    });
    observed = synced.entries;
    expect(observed.map((entry) => entry.resource.label).sort()).toEqual([
      world.names.connection, world.names.plugin, world.names.provider, world.names.skill,
    ].sort());
    expect(observed.every((entry) => entry.change === "available")).toBe(true);
    const remote = await world.inventory("recipient");
    expect(remote.providers).toContain(providerId);
    expect(remote.connections).toContain(connectionId);
    expect(JSON.stringify(remote.library)).toContain(pluginId);
    const requests = (await world.requests()).slice(beforeRequests);
    const reads = successfulInventoryReads(requests);
    expect(reads).toHaveLength(inventoryPaths.length);
    expect(requests.some((request) => request.path.endsWith(`/v1/plugins/${pluginId}/resolved`) && request.status === 200)).toBe(true);
    for (const name of [world.names.provider, world.names.skill, world.names.plugin, world.names.connection]) await user.see(compact(name));
    await user.notSee(retry);
    expect(synced.unreadCount).toBe(4);
    expect((await probe.dom("[data-notification-panel] [data-activity-unread]")).elements).toHaveLength(4);
    expect((await probe.dom("[data-notification-panel] [data-activity-row] a")).elements).toHaveLength(5);
    expect((await probe.dom("[data-notification-panel] [data-activity-row] a button")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Real sync, not injected history, adds the four changes", `${reads.length} inventory endpoints and the shared plugin detail returned 200 after Retry; ${observed.length} unread compact rows match the member's Den grants, above the summary row; whole-row links with no nested action buttons`, true);
    await user.screenshot();
  });

  await step("a compact resource row opens its existing Library destination and closes Activity", async () => {
    await user.click({ role: "link", label: `Open ${world.names.plugin}` });
    const expected = `/extensions/${encodeURIComponent(`plugin:${pluginId}`)}`;
    await probe.eventually(() => world.location(), {
      within: 10_000, label: "the shared plugin opens from Activity", until: (path) => path.endsWith(expected),
    });
    await user.see({ text: world.names.plugin });
    await waitForPopoverClosed();
    await caughtUp();
    expect((await feed()).unreadCount).toBe(0);
    evidence.recordAssertionEvidence("The compact row is a working destination, not just a receipt", `The whole-row link opens the shared plugin in Library; closing Activity marked 4 rows read; all ${(await feed()).entries.length} observations remain`, true);
    await user.screenshot();
    await user.click(bell);
  });

  await step("View all opens the member's Activity page alongside their conversations", async () => {
    await user.click({ role: "button", label: "View all" });
    await user.see({ role: "button", label: "All" });
    await user.see({ role: "heading", label: "Activity" });
    await user.see({ text: `Skill in ${world.names.plugin}` });
    await user.see({ role: "button", label: "New session" });
    expect(await world.location()).toBe("/activity");
    await waitForPopoverClosed();
    for (const name of [world.names.provider, world.names.skill, world.names.plugin, world.names.connection]) await user.see(available(name));
    await user.see({ role: "button", label: `Try ${world.names.skill} in a new session` });
    expect((await feed()).entries).toEqual(observed);
    expect((await probe.dom("[data-notification-bell][aria-current='page']")).elements.length).toBeGreaterThan(0);
    await caughtUp();
    evidence.recordAssertionEvidence("The full page keeps the normal sidebar and unchanged history", `/activity; 4 changes with Try it, Browse and Open actions; conversation sidebar visible; the bell shows the current page`, true);
    await user.screenshot();
  });

  const filters = [
    { label: "Skills", kind: "skill", name: world.names.skill, action: { role: "button", label: `Try ${world.names.skill} in a new session` } satisfies Target },
    { label: "Plugins", kind: "plugin", name: world.names.plugin, action: { role: "link", label: `Open ${world.names.plugin}` } satisfies Target },
    { label: "Connections", kind: "connection", name: world.names.connection, action: { role: "link", label: `Open ${world.names.connection}` } satisfies Target },
  ];
  const allNames = [world.names.provider, ...filters.map((filter) => filter.name)];
  for (const filter of filters) {
    await step(`the member narrows Activity to ${filter.label.toLowerCase()}`, async () => {
      await user.click({ role: "button", label: filter.label });
      await user.see(available(filter.name));
      await user.see(filter.action);
      for (const other of allNames.filter((name) => name !== filter.name)) await user.notSee(available(other));
      const rows = (await probe.dom("[data-activity-page] [data-activity-row]")).elements;
      expect(rows).toHaveLength(1);
      evidence.recordAssertionEvidence(`${filter.label} shows only that kind of change`, `${rows.length} matching row with its design action, and 0 rows from other kinds; history still has ${(await feed()).entries.length} entries`, true);
      await user.screenshot();
    });
  }

  await step("a shared skill update appears after the member's next successful sync", async () => {
    const beforeRequests = (await world.requests()).length;
    const update = await world.updateBriefing();
    await user.reload();
    const synced = await probe.eventually(feed, {
      within: 60_000, label: "published skill revision reaches Activity", until: (value) => value.refreshState === "idle"
        && value.entries.some((entry) => entry.resource.id === update.skillId && entry.change === "updated"),
    });
    observed = synced.entries;
    await user.click({ role: "button", label: "Skills" });
    await user.see({ text: `A new version of ${world.names.skill} was published` });
    await user.see(available(world.names.skill));
    const requests = (await world.requests()).slice(beforeRequests);
    expect(requests.some((request) => request.path.endsWith(`/v1/plugins/${pluginId}/resolved`) && request.status === 200)).toBe(true);
    expect(observed.filter((entry) => entry.change === "updated")).toHaveLength(1);
    evidence.recordAssertionEvidence("A real published revision becomes one update", `Publishing returned HTTP ${update.status}; the app fetched the shared plugin again; 1 new skill update retains the earlier access entry`, true);
    await user.screenshot();
  });

  await step("removed connection access stays visible with a lock and who can change it", async () => {
    const beforeRequests = (await world.requests()).length;
    expect(await world.removeConnectionAccess()).toBe(200);
    await user.reload();
    const synced = await probe.eventually(feed, {
      within: 60_000, label: "revoked access reaches the member", until: (value) => value.refreshState === "idle"
        && value.entries.some((entry) => entry.resource.id === connectionId && entry.change === "unavailable"),
    });
    observed = synced.entries;
    await user.click({ role: "button", label: "Connections" });
    await user.see({ text: `${world.names.connection} is no longer shared with you` });
    await user.see({ text: "Ask an admin" });
    await user.notSee({ role: "link", label: `Open ${world.names.connection}` });
    const unavailable = (await probe.dom('[data-activity-page] [data-activity-kind="connection"][data-unavailable="true"]')).elements;
    const askAdmin = (await probe.dom('[data-activity-page] [data-activity-kind="connection"] [data-activity-ask-admin]')).elements;
    expect(unavailable).toHaveLength(1);
    expect(askAdmin).toHaveLength(1);
    expect((await probe.dom('[data-activity-page] [data-activity-kind="connection"] a, [data-activity-page] [data-activity-kind="connection"] button')).elements).toHaveLength(0);
    expect((await world.inventory("recipient")).connections).not.toContain(connectionId);
    const requests = (await world.requests()).slice(beforeRequests);
    expect(requests.some((request) => request.path.endsWith("/v1/mcp-connections?scope=usable") && request.status === 200)).toBe(true);
    evidence.recordAssertionEvidence("Revocation is visible without a dead-end action", `Den's usable inventory no longer includes the connection; the removal row is muted with a lock and Ask an admin; the earlier share stays readable; 0 links or buttons`, true);
    await user.screenshot();
  });

  await step("the bell keeps the latest five changes while View all retains the full history", async () => {
    expect(observed.length).toBeGreaterThan(5);
    await user.click(bell);
    await user.see({ text: `${world.names.connection} removed` });
    const rows = (await probe.dom("[data-notification-panel] [data-activity-row]")).elements;
    expect(rows).toHaveLength(5);
    expect(rows[0]?.text).toContain(`${world.names.connection} removed`);
    await user.screenshot();
    await user.click({ role: "button", label: "View all" });
    await waitForPopoverClosed();
    await user.click({ role: "button", label: "All" });
    const full = (await probe.dom("[data-activity-page] [data-activity-row]")).elements;
    // Every change plus the one summary of what was already shared.
    expect(full).toHaveLength(observed.length + 1);
    evidence.recordAssertionEvidence("The compact view does not discard older changes", `5 latest popover rows, newest first; View all retains all ${full.length} rows`, true);
    await user.screenshot();
  });

  await step("a failed refresh keeps the last known Activity and its verification time", async () => {
    await world.failInventory();
    await user.reload();
    await user.see(retry, { timeoutMs: 60_000 });
    const state = await probe.eventually(feed, {
      within: 30_000, label: "failed refresh preserves history", until: (value) => value.refreshState === "error",
    });
    expect(state.entries).toEqual(observed);
    expect(state.verifiedAt).not.toBeNull();
    await user.see({ text: /^Couldn’t refresh\. Showing activity from .+\.$/ });
    await user.see(available(world.names.provider));
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(0);
    const failures = (await world.requests()).filter((request) => request.status === 503 && request.path.endsWith("/v1/llm-providers"));
    evidence.recordAssertionEvidence("An outage does not erase or invent changes", `${failures.length} witnessed HTTP 503 responses; all ${observed.length} entries and the last verification time remain; Retry is visible`, true);
    await user.screenshot();
  });

  await step("Retry and reload preserve history and read state without duplicates", async () => {
    await world.recoverInventory();
    await user.click(retry);
    expect((await baseline()).entries).toEqual(observed);
    await user.notSee(retry);
    await user.reload();
    expect((await baseline()).entries).toEqual(observed);
    await user.see(available(world.names.provider));
    await caughtUp();
    const persisted = JSON.stringify(await probe.storage("openwork:member-activity:v1"));
    expect(persisted).toContain(connectionId);
    expect(persisted).toContain('"seenAt"');
    expect(persisted).not.toMatch(/"(?:readAt|unread|activeScopeKey)"/);
    evidence.recordAssertionEvidence("Device history and its seen time persist per member", `${observed.length} entries retain their IDs after Retry and reload; 0 duplicates; one member seen time, no per-entry read flags or active identity`, true);
    await user.screenshot();
  });

  await step("another member on the same device sees none of the first member's changes", async () => {
    await agent.run("auth.exchange-grant", await world.handoff("other"));
    await probe.eventually(() => agent.run("auth.status"), {
      within: 60_000, label: "second member is signed in", until: (value) => signedInAs(value, world.emails.other),
    });
    await user.navigate(`${world.app.webUrl}/activity`);
    const otherState = await baseline();
    expect(otherState.entries).toEqual([]);
    expect(otherState.baseline).toContain(world.names.baseline);
    const remote = await world.inventory("other");
    expect(remote.providers).not.toContain(providerId);
    expect(JSON.stringify(remote.library)).not.toContain(pluginId);
    expect(remote.connections).not.toContain(connectionId);
    await user.see(alreadyShared);
    await user.see({ role: "link", label: "Open Library" });
    for (const name of allNames) await user.notSee(available(name));
    evidence.recordAssertionEvidence("History is scoped to the signed-in member, not the device", `Same browser profile, second verified member; 0 Activity entries and no private model, plugin, or connection in their Den inventory`, true);
    await user.screenshot();
  });

  await step("an administrator still gets personal Activity rather than an organization-wide view", async () => {
    await agent.run("auth.exchange-grant", await world.handoff("admin"));
    await probe.eventually(() => agent.run("auth.status"), {
      within: 60_000, label: "administrator is signed in", until: (value) => signedInAs(value, world.emails.admin),
    });
    await user.navigate(`${world.app.webUrl}/activity`);
    expect((await baseline()).entries).toEqual([]);
    await user.see(alreadyShared);
    await user.notSee({ role: "tab", label: /Organization/i });
    await user.notSee({ role: "button", label: /Organization activity/i });
    for (const name of allNames) await user.notSee(available(name));
    evidence.recordAssertionEvidence("Administrative access does not reveal another member's local history", `Third verified identity on the same device; 0 entries on its first inventory; no organization Activity switch`, true);
    await user.screenshot();
  });

  await step("the original member returns to their own saved history", async () => {
    await agent.run("auth.exchange-grant", await world.handoff("recipient"));
    await probe.eventually(() => agent.run("auth.status"), {
      within: 60_000, label: "original member is signed in again", until: (value) => signedInAs(value, world.emails.recipient),
    });
    await user.navigate(`${world.app.webUrl}/activity`);
    expect((await baseline()).entries).toEqual(observed);
    await user.see(available(world.names.provider));
    await user.see({ text: `${world.names.connection} is no longer shared with you` });
    await caughtUp();
    evidence.recordAssertionEvidence("Returning to an account restores only its history", `The original ${observed.length} entry IDs return after two other identities used the same profile; unavailable access remains locked`, true);
    await user.screenshot();
  });
});
