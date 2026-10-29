import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { adminFreeAutoConversionsWorld } from "../worlds/admin-free-auto-conversions.ts";

const test = spec.world(adminFreeAutoConversionsWorld, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

test("a platform admin identifies accounts and paid customers who came back after the free Auto limit", async ({ world, user, step, evidence, probe }) => {
  const admin = user.on(world.web), anonymous = user.on(world.anonymous);
  const newJourney = "1".repeat(64), returningJourney = "2".repeat(64);

  await step("before: opening Free Auto leaves distant conversion analytics unloaded", async () => {
    await admin.see({ role: "heading", label: "Free Auto usage" }, { timeoutMs: 60_000 });
    const pending = await probe.on(world.web).dom('[data-admin-deferred="pending"]');
    expect(pending.elements[0]?.rect.top).toBeGreaterThan(600);
    const reads = await world.conversionReads();
    expect(reads).toBe(0);
    evidence.recordAssertionEvidence("Off-screen conversion analytics do no work", `pending sections=${pending.elements.length}; first section=${pending.elements[0]?.rect.top}px; completed conversion reads=${reads}`, reads === 0 && (pending.elements[0]?.rect.top ?? 0) > 600);
    await admin.screenshot();
  });

  await step("after: approaching conversion activity loads it once and scrolling back reuses it", async () => {
    await admin.resizeViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await admin.see({ text: "No tracked limit observations in this range. New activity will appear here after tracking is deployed." });
    const first = await probe.eventually(() => world.conversionReads(), { within: 10_000, until: (reads) => reads === 1, label: "visible conversion read" });
    await admin.wheelAt({ x: 1000, y: 700, deltaY: 1200 });
    await admin.wheelAt({ x: 1000, y: 700, deltaY: -1200 });
    const repeated = await world.conversionReads();
    expect(repeated).toBe(first);
    evidence.recordAssertionEvidence("Conversion activity is reused after its first reveal", `first visit=${first}; after scrolling away and back=${repeated}`, first === 1 && repeated === first);
    await admin.screenshot();
  });

  await step("before: the admin sees no tracked conversions or invented historical guest identities", async () => {
    await admin.see({ role: "heading", label: "After the free limit" }, { timeoutMs: 60_000 });
    await admin.see({ text: "No tracked limit observations in this range. New activity will appear here after tracking is deployed." });
    expect((await world.report()).totals.reachedLimit).toBe(0);
    await admin.screenshot();
  });

  await step("a real guest limit is recorded once even when the app checks it again", async () => {
    const first = await world.exhaustGuest(newJourney), second = await world.exhaustGuest(newJourney);
    expect(first).toMatchObject({ status: 200, body: { state: "exhausted" } });
    expect(second).toMatchObject({ status: 200, body: { state: "exhausted" } });
    const report = await world.report();
    expect(report.totals).toMatchObject({ reachedLimit: 1, unlinkedGuests: 1, signedIn: 0, subscribed: 0 });
    expect(report.rows[0]?.userId).toBeNull();
    evidence.recordAssertionEvidence("Repeated limit status checks do not add people", "Two exhausted responses from the real Gateway produce one anonymous journey and no attributed account.", report.totals.reachedLimit === 1 && report.rows[0]?.userId === null);
  });

  await step("a repeated exhausted check answers without waiting on analytics storage", async () => {
    const result = await world.exhaustedCheckWhileAnalyticsLocked(newJourney);
    expect(result).toMatchObject({ status: 200, state: "exhausted" });
    expect(result.elapsedMs).toBeLessThan(3_000);
    expect((await world.report()).totals.reachedLimit).toBe(1);
    evidence.recordAssertionEvidence("Limit analytics stay off the free Auto request path",
      `With this network's analytics row locked for 8 s, a repeat check for an already recorded journey answered "${String(result.state)}" in ${result.elapsedMs} ms and added no observation.`,
      result.state === "exhausted" && result.elapsedMs < 3_000);
  });

  await step("after: the admin can distinguish a new account from an existing free member returning", async () => {
    expect((await world.exhaustGuest(returningJourney)).body.state).toBe("exhausted");
    await world.createAccountAndReturn(newJourney);
    await world.returnExisting(returningJourney);
    await world.returningSignIn();
    const report = await world.report();
    expect(report.totals).toMatchObject({ reachedLimit: 2, signedIn: 2, newAccounts: 1, subscribed: 0, unlinkedGuests: 0 });
    const newCustomer = report.rows.find((row) => row.name === "New Free Customer");
    expect(newCustomer?.signedUpAt).not.toBeNull();
    expect(report.rows.find((row) => row.name === "Returning Free Member")?.signedUpAt).toBeNull();
    await admin.click({ role: "button", label: "Refresh" });
    await admin.see({ role: "link", label: "New Free Customer" });
    await admin.see({ role: "link", label: "Returning Free Member" });
    await admin.see({ testId: "free-auto-conversion-chart" });
    evidence.recordAssertionEvidence("Account creation and return sign-in are separate outcomes", "Real guest and authenticated status requests link each reported journey; the session hook preserves the returning member's later login. Only the account created after its guest limit counts as a new signup.", report.totals.signedIn === 2 && report.totals.newAccounts === 1 && typeof newCustomer?.signedUpAt === "string");
    await admin.screenshot();
  });

  await step("an active subscription without a positive payment does not become a paid conversion", async () => {
    await world.purchase(false);
    const report = await world.report();
    expect(report.totals.subscribed).toBe(0);
    evidence.recordAssertionEvidence("Subscription state is not payment evidence", "A verified subscription-created event followed by an invoice with no payment leaves paid conversions at zero.", report.totals.subscribed === 0);
  });

  await step("after: confirmed payment identifies the buyer once and the admin can open that account", async () => {
    const buyerId = await world.purchase(true);
    await world.purchase(true);
    const report = await world.report();
    expect(report.totals.subscribed).toBe(1);
    const buyer = report.rows.find((row) => row.userId === buyerId);
    expect(buyer).toBeDefined();
    expect(buyer?.subscribedAt).not.toBeNull();
    expect(Date.parse(buyer?.subscribedAt ?? "") > Date.parse(buyer?.exhaustedAt ?? "")).toBe(true);
    await admin.click({ role: "button", label: "Refresh" });
    await admin.click({ role: "button", label: "Show Paid subscriptions" });
    await admin.see({ text: "1 matching accounts / journeys · page 1 · dates in UTC" });
    await admin.see({ role: "link", label: "New Free Customer" });
    await admin.notSee({ role: "link", label: "Returning Free Member" });
    await admin.reload();
    await admin.see({ text: "1 matching accounts / journeys · page 1 · dates in UTC" });
    await admin.screenshot();
    await admin.click({ role: "link", label: "New Free Customer" });
    await admin.see({ role: "heading", label: "Users" }, { timeoutMs: 60_000 });
    await admin.see({ text: "New Free Customer" });
    evidence.recordAssertionEvidence("Paid attribution is idempotent and belongs to the checkout creator", "Two verified paid-invoice deliveries produce one buyer. The outcome survives reload and its person link opens the filtered Users route.", report.totals.subscribed === 1 && buyer?.userId === buyerId);
  });

  await step("old renewals and duplicate weekly observations cannot inflate the cohort, and the people list is bounded", async () => {
    await world.boundaries();
    const report = await world.report();
    expect(report.totals).toEqual({ reachedLimit: 55, signedIn: 2, newAccounts: 1, subscribed: 1, unlinkedGuests: 52 });
    expect(report.daily.reduce((sum, day) => sum + day.reachedLimit, 0)).toBe(55);
    const second = await world.report("stage=unlinked&page=2");
    expect(second.rows).toHaveLength(2);
    expect(second.page).toMatchObject({ total: 52, hasMore: false });
    await admin.navigate(world.url("/admin/free-auto?conversionStage=unlinked&page=2&days=30"));
    await admin.see({ text: "52 matching accounts / journeys · page 2 · dates in UTC" }, { timeoutMs: 60_000 });
    await admin.reload();
    await admin.see({ text: "52 matching accounts / journeys · page 2 · dates in UTC" }, { timeoutMs: 60_000 });
    await admin.screenshot();
    await admin.navigate(world.url("/admin/free-auto?search=New%20Free%20Customer&conversionStage=subscribed"));
    await admin.see({ text: "1 matching accounts / journeys · page 1 · dates in UTC" });
    evidence.recordAssertionEvidence("Range, identity, and pagination boundaries hold", "An old subscription's renewal is excluded; two observations for one known account count once; a 70-day observation is outside the default range. The second 50-row page has two of 52 unlinked guests and survives reload.", report.totals.reachedLimit === 55 && second.rows.length === 2 && second.page.total === 52);
  });

  await step("rotating anonymous headers cannot grow history beyond the network's daily bound", async () => {
    const result = await world.guestObservationCap();
    expect(result.exhausted).toBe(120);
    expect(result.observations).toBe(100);
    evidence.recordAssertionEvidence("Anonymous analytics storage is bounded independently of client headers",
      "120 concurrent-batched requests with distinct journey identifiers from the same exhausted IP leave exactly 100 real guest observations, including the two earlier journeys. All requests retain the exhausted allowance response.", result.exhausted === 120 && result.observations === 100);
  });

  await step("signed-out visitors and ordinary members cannot read account conversion information", async () => {
    await anonymous.see({ role: "heading", label: "Sign in required" }, { timeoutMs: 60_000 });
    const busy = await probe.on(world.anonymous).dom('[aria-busy="true"], .animate-pulse');
    expect(busy.elements).toHaveLength(0);
    const memberStatus = (await probe.api(world.returning, "/v1/admin/free-auto/conversions")).response.status;
    const anonymousStatus = await world.anonymousAccess();
    expect(memberStatus).toBe(403);
    expect(anonymousStatus).toBe(401);
    evidence.recordAssertionEvidence("Conversion identities remain platform-admin only", "Anonymous API access is 401, an ordinary member is 403, and the signed-out UI displays no skeleton or data panel.", memberStatus === 403 && anonymousStatus === 401 && busy.elements.length === 0);
    await anonymous.screenshot();
  });
});
