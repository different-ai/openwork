import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { calendarInventory } from "../worlds/calendar-inventory.ts";

const test = spec.world(calendarInventory, { timeout: 300_000, needs: { placement: "local" }, resources: { surfaces: [], services: ["den"] } });

test("a member finds later automations and their full history without sharing an unseen selection", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("after: the calendar opens without choosing work for the member", async () => {
    await user.see({ text: /More automations are available/ });
    expect((await probe.dom("[data-calendar-detail]")).elements).toHaveLength(0);
    await user.type({ role: "textbox", label: "Message Workbot" }, "What is on my calendar?");
    await user.press("Enter");
    const sent = await probe.eventually(() => world.messages(), { within: 5000, label: "a range question has no selected item", until: values => values.length === 1 });
    expect(sent[0]).toMatchObject({ context: { kind: "calendar" } });
    expect(sent[0]).not.toHaveProperty("context.selected");
    evidence.recordAssertionEvidence("Data arrival opens no detail and shares no selected automation", JSON.stringify(sent[0]), (await probe.dom("[data-calendar-detail]")).elements.length === 0);
    await user.screenshot();
  });
  await step("the member searches beyond the first page and opens an automation", async () => {
    await user.click({ text: /Find automations and history/ });
    await user.type({ label: "Search loaded calendar" }, "Weekly summary");
    await user.see({ text: /No matching automations in 100 loaded/ });
    await user.click({ role: "button", label: "Load more automations" });
    await user.click({ role: "button", label: "Weekly summary" });
    await user.see({ role: "heading", label: "Weekly summary" });
    const paged = world.requests().some(value => value.includes("/automations?limit=100&cursor=100"));
    expect(paged).toBe(true);
    expect((await probe.dom("[data-calendar-directory-results] li")).elements.length).toBeLessThanOrEqual(20);
    evidence.recordAssertionEvidence("The later automation remains reachable through the real cursor", "cursor=100 requested; Weekly summary opened", paged);
    await user.screenshot();
  });
  await step("filtering out a selection discards it even after the filter is cleared", async () => {
    await user.type({ label: "Search loaded calendar" }, "not-present", { replace: true });
    await user.see({ text: /No matching automations in 120 loaded/ });
    await user.type({ label: "Search loaded calendar" }, "", { replace: true });
    await user.notSee({ role: "heading", label: "Weekly summary" });
    await user.type({ role: "textbox", label: "Message Workbot" }, "Summarize the calendar overview");
    await user.press("Enter");
    const sent = await probe.eventually(() => world.messages(), { within: 5000, label: "clearing the filter cannot restore shared selection", until: values => values.length === 2 });
    expect(sent[1]).not.toHaveProperty("context.selected");
    evidence.recordAssertionEvidence("A hidden selection stays discarded after clearing search", JSON.stringify(sent[1]), (await probe.dom("[data-calendar-detail]")).elements.length === 0);
    await user.screenshot();
  });
  await step("refreshing away and restoring an automation cannot resurrect its selection", async () => {
    await user.type({ label: "Search loaded calendar" }, "Weekly summary", { replace: true });
    await user.click({ role: "button", label: "Weekly summary" });
    world.hideAutomation();
    await user.click({ role: "button", label: "Refresh calendar" });
    await user.see({ text: /No matching automations in 119 loaded/ });
    await user.notSee({ role: "heading", label: "Weekly summary" });
    world.restoreAutomation();
    await user.click({ role: "button", label: "Refresh calendar" });
    await user.see({ role: "button", label: "Weekly summary" });
    await user.notSee({ role: "heading", label: "Weekly summary" });
    await user.type({ role: "textbox", label: "Message Workbot" }, "Summarize the refreshed overview");
    await user.press("Enter");
    const sent = await probe.eventually(() => world.messages(), { within: 5000, label: "restoration cannot restore shared selection", until: values => values.length === 3 });
    expect(sent[2]).not.toHaveProperty("context.selected");
    evidence.recordAssertionEvidence("A refreshed-away selection stays discarded when the item returns", JSON.stringify(sent[2]), (await probe.dom("[data-calendar-detail]")).elements.length === 0);
    await user.screenshot();
    await user.click({ role: "button", label: "Weekly summary" });
  });
  await step("a failed receipt is unknown until Retry verifies it", async () => {
    await user.click({ role: "button", label: "Open", nth: 0 });
    await user.see({ text: "Couldn't verify this result." });
    await user.notSee({ text: "No result was recorded for this run." });
    await user.screenshot();
    world.restoreReceipts();
    await user.click({ role: "button", label: "Retry" });
    await user.see({ text: "Recorded result 0" });
    await user.click({ role: "button", label: "Open", nth: 0 });
    await user.see({ text: "No result was recorded for this run." });
    evidence.recordAssertionEvidence("Failure and verified absence are different states", "503: Couldn't verify; Retry: Recorded result 0; successful empty receipt: No result was recorded", world.requests().filter(value => value.endsWith("/automation-runs/run_0")).length >= 2);
    await user.screenshot();
  });
  await step("the full history route pages past the overview and first request", async () => {
    await user.click({ role: "link", label: "Open full history" });
    await user.see({ role: "heading", label: "Run history" });
    expect(await probe.url()).toContain(`history=${world.historyId}`);
    await user.click({ role: "button", label: "Load more runs" });
    await user.see({ text: "Showing 21–40 of 40 loaded; more runs available." });
    await user.click({ role: "button", label: "Load more runs" });
    await user.see({ text: "Showing 41–45 of 45 loaded; all runs loaded." });
    expect((await probe.dom("[data-calendar-past-run]")).elements).toHaveLength(5);
    const paged = world.requests().some(value => value.includes(`/${world.historyId}/runs?limit=20&cursor=40`));
    expect(paged).toBe(true);
    world.failHistoryDetail();
    await user.reload();
    await user.see({ text: "Couldn't verify this automation." });
    await user.notSee({ role: "heading", label: "Weekly summary" });
    world.restoreHistoryDetail();
    await user.click({ role: "button", label: "Retry" });
    await user.see({ role: "heading", label: "Run history" });
    await user.see({ role: "heading", label: "Weekly summary" });
    await user.notSee({ text: "Couldn't verify this automation." });
    const productionRead = world.productionDetailStatuses().filter(status => status === 200).length >= 2;
    expect(productionRead).toBe(true);
    evidence.recordAssertionEvidence("All 45 runs and a retried later-item deep link use the real proxy", "cursor=40 reached run 45; reload503 stayed unverified, then Retry fetched owner-scoped detail through production Den's real proxy", paged && productionRead);
    await user.screenshot();
  });
  await step("changing range clears the detail and the next question's selected context", async () => {
    await user.click({ role: "button", label: /^Next$/ });
    await user.notSee({ role: "heading", label: "Weekly summary" });
    await user.type({ role: "textbox", label: "Message Workbot" }, "What about this week?");
    await user.press("Enter");
    const sent = await probe.eventually(() => world.messages(), { within: 5000, label: "range navigation clears the shared selection", until: values => values.length === 4 });
    expect(sent[3]).not.toHaveProperty("context.selected");
    await user.click({ role: "button", label: /^Previous$/ });
    await user.notSee({ role: "heading", label: "Weekly summary" });
    evidence.recordAssertionEvidence("An earlier selection cannot silently return with an earlier range", JSON.stringify(sent[3]), (await probe.dom("[data-calendar-detail]")).elements.length === 0);
    await user.screenshot();
  });
});

test("a member can distinguish partial calendar ranges and failed reads from an empty calendar", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("after: capped run and meeting reads remain visibly incomplete", async () => {
    await user.navigate(`${world.url}calendar?dense=1`);
    await user.see({ text: /Some runs may be missing from this range/ });
    await user.see({ text: /Some Google Calendar meetings may be missing/ });
    expect((await probe.dom("[data-calendar-automation]")).elements.length).toBeLessThanOrEqual(100);
    const runRequests = world.requests().filter(value => value.includes("automation-runs?from="));
    expect(runRequests.length).toBeGreaterThanOrEqual(10);
    evidence.recordAssertionEvidence("Bounded reads never claim complete coverage", `${runRequests.length} range pages; run and Google incompleteness shown`, (await probe.dom("[data-calendar-incomplete]")).elements.length >= 2);
    await user.screenshot();
  });
  await step("a range failure offers Retry instead of claiming there were no runs", async () => {
    world.failRange();
    await user.navigate(`${world.url}calendar?count=0`);
    await user.see({ text: "Couldn't verify runs for this range." });
    evidence.recordAssertionEvidence("A failed range is not an empty range", "503 range response; Couldn't verify runs for this range and Retry", world.requests().some(value => value.includes("automation-runs?from=")));
    await user.screenshot();
  });
  await step("Retry verifies the same range without opening a detail panel", async () => {
    world.restoreRange();
    await user.click({ role: "button", label: "Retry" });
    await probe.eventually(() => probe.dom('[role="alert"]'), { within: 5000, label: "the recovered range clears its verification error", until: value => value.elements.every(element => !element.text.includes("Couldn't verify runs for this range.")) });
    await user.notSee({ text: "Couldn't verify runs for this range." });
    expect((await probe.dom("[data-calendar-detail]")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Recovery leaves selection to the member", "The range recovers; no automation detail is opened", (await probe.dom("[data-calendar-detail]")).elements.length === 0);
    await user.screenshot();
  });
});

test("a member cannot uncover a denied calendar by retrying during a network failure", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("the member explicitly opens a later automation and its shared context", async () => {
    await user.see({ text: /More automations are available/ });
    await user.click({ text: /Find automations and history/ });
    await user.click({ role: "button", label: "Load more automations" });
    await user.type({ label: "Search loaded calendar" }, "Weekly summary");
    await user.click({ role: "button", label: "Weekly summary" });
    await user.see({ role: "heading", label: "Weekly summary" });
    await user.see({ testId: "workbot-view-context", text: /Weekly summary/ });
    evidence.recordAssertionEvidence("The sensitive cached selection is really present before denial", "Weekly summary detail and shared-context chip are visible", (await probe.dom("[data-calendar-detail]")).elements.length === 1);
    await user.screenshot();
  });
  await step("a denied refresh removes cached detail, directory and shared context", async () => {
    world.denyInventory();
    await user.click({ role: "button", label: "Refresh calendar" });
    await user.see({ text: /Calendar access is blocked/ });
    await user.notSee({ role: "heading", label: "Weekly summary" });
    expect((await probe.dom("[data-calendar-detail], [data-calendar-directory], [data-workbot-view-context]")).elements).toHaveLength(0);
    await user.type({ role: "textbox", label: "Message Workbot" }, "Check my calendar access");
    await user.press("Enter");
    const sent = await probe.eventually(() => world.messages(), { within: 5000, label: "a denied calendar is not shared with chat", until: values => values.length === 1 });
    expect(sent[0]).not.toHaveProperty("context");
    evidence.recordAssertionEvidence("An authoritative denial masks detail and stops context sharing", JSON.stringify(sent[0]), (await probe.dom("[data-calendar-detail], [data-workbot-view-context]")).elements.length === 0);
    await user.screenshot();
  });
  await step("a later failed read cannot reveal the pre-denial calendar", async () => {
    world.unavailableInventory();
    const before = world.inventoryResponses().length;
    await user.click({ role: "button", label: "Retry" });
    await probe.eventually(() => world.inventoryResponses(), { within: 15000, label: "a post-denial read really answers 503", until: values => values.slice(before).includes(503) });
    await probe.eventually(() => probe.dom('button:not(:disabled)'), { within: 15000, label: "the unavailable inventory retry finishes", until: value => value.elements.some(element => element.text === "Retry") });
    await user.see({ text: /Calendar access is blocked/ });
    await user.notSee({ role: "heading", label: "Weekly summary" });
    expect((await probe.dom("[data-calendar-detail], [data-calendar-directory], [data-workbot-view-context]")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("403 followed by 503 stays masked", "The unavailable retry finishes; no cached calendar detail, directory or shared context returns", (await probe.dom("[data-calendar-detail], [data-workbot-view-context]")).elements.length === 0);
    await user.screenshot();
  });
  await step("authorized recovery restores browsing but not a previous selection", async () => {
    world.authorizeInventory();
    await user.click({ role: "button", label: "Retry" });
    await user.see({ text: /Find automations and history/ });
    expect((await probe.dom("[data-calendar-detail]")).elements).toHaveLength(0);
    await user.click({ text: /Find automations and history/ });
    await user.click({ role: "button", label: "Load more automations" });
    await user.click({ role: "button", label: "Weekly summary" });
    await user.see({ role: "heading", label: "Weekly summary" });
    evidence.recordAssertionEvidence("Only an authorized read and an explicit choice restore the detail", "Browsing recovers unselected; Weekly summary opens only after the member chooses it again", (await probe.dom("[data-calendar-detail]")).elements.length === 1);
    await user.screenshot();
  });
});

test("a member's blocked meetings stay masked through a provider failure and do not reselect on recovery", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("the member opens a meeting before its access is blocked", async () => {
    await user.see({ role: "button", label: /^Team review,/ });
    await user.click({ role: "button", label: /^Team review,/ });
    await user.see({ role: "heading", label: "Team review" });
    await user.see({ testId: "workbot-view-context", text: /Team review/ });
    evidence.recordAssertionEvidence("The meeting is present before the denial", "Team review detail and current shared context are visible", (await probe.dom("[data-calendar-meeting-detail]")).elements.length === 1);
    await user.screenshot();
  });
  await step("an organization block masks the previous meeting and selected context", async () => {
    world.denyMeetings();
    await user.click({ role: "button", label: "Refresh calendar" });
    await user.see({ text: "Google Calendar is blocked by your organization" });
    await user.notSee({ role: "button", label: /^Team review,/ });
    await user.notSee({ role: "heading", label: "Team review" });
    expect((await probe.dom("[data-calendar-meeting-detail]")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("An authoritative provider denial cannot show a cached meeting", "Google Calendar returns403 policy_blocked; meeting block and detail disappear", world.meetingResponses().includes(403));
    await user.screenshot();
  });
  await step("a later provider failure does not uncover the denied meeting", async () => {
    world.unavailableMeetings();
    const before = world.meetingResponses().length;
    await user.click({ role: "button", label: "Refresh calendar" });
    await probe.eventually(() => world.meetingResponses(), { within: 15000, label: "the provider really fails after the denial", until: values => values.slice(before).filter(status => status === 503).length >= 3 });
    await user.notSee({ role: "button", label: /^Team review,/ });
    await user.notSee({ role: "heading", label: "Team review" });
    evidence.recordAssertionEvidence("403 followed by503 retains the meeting barrier", "Three provider503 reads; no old meeting or detail reappears", (await probe.dom("[data-calendar-meeting], [data-calendar-meeting-detail]")).elements.length === 0);
    await user.screenshot();
  });
  await step("authorized meeting recovery does not restore an earlier selection", async () => {
    world.authorizeMeetings();
    await user.click({ role: "button", label: "Refresh calendar" });
    await user.see({ role: "button", label: /^Team review,/ });
    await user.notSee({ role: "heading", label: "Team review" });
    await user.type({ role: "textbox", label: "Message Workbot" }, "Summarize this calendar range");
    await user.press("Enter");
    const sent = await probe.eventually(() => world.messages(), { within: 5000, label: "the recovered meeting is not selected in chat", until: values => values.length === 1 });
    expect(sent[0]).not.toHaveProperty("context.selected");
    evidence.recordAssertionEvidence("A fresh meeting read restores availability, not an old selection", JSON.stringify(sent[0]), (await probe.dom("[data-calendar-meeting-detail]")).elements.length === 0);
    await user.screenshot();
  });
});
