import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OUTREACH_PLAYS, type AdminOutreach, type OutreachItem } from "@openwork/types/den/admin-organization";
import { outreachDraft } from "./admin-opportunity-draft";
import { OutreachList, outreachRowsAsText } from "./admin-outreach-page";

/** The admin Opportunities list: each row says who to write to and why, and can be copied into a sheet. */

const item: OutreachItem = {
  organizationId: "org_1", organizationName: "Maple Robotics", play: "team_no_plan",
  reason: "3 people ran tasks in the last 14 days, no Team plan", also: ["Ava reached the free model limit once in the last 7 days"],
  company: "maple.test", contact: { userId: "u1", name: "Ava Chen", email: "ava@maple.test", role: "member", activeDays: 9 },
  others: [{ userId: "u2", name: "Ben Ito", email: "ben@maple.test", role: "owner", activeDays: 2 }],
  people: { members: 4, active: 3 }, billing: { plan: "free", paying: false, modelsAddOn: false }, endsAt: null, lastActiveAt: "2026-11-16T10:00:00.000Z", followUp: null,
};
const totals = Object.fromEntries(OUTREACH_PLAYS.map(play => [play, play === "team_no_plan" ? 1 : 0])) as AdminOutreach["totals"];
const data: AdminOutreach = {
  generatedAt: "2026-11-17T12:00:00.000Z", windowDays: 14, totals: { ...totals, lapsed_failed: 1 }, hidden: 2,
  items: [item, { ...item, organizationId: "org_3", organizationName: "Harbor Analytics", play: "lapsed_failed", reason: "Stopped 20 days ago after 4 of 10 tasks failed", also: [], people: { members: 1, active: 0 }, lastActiveAt: "2026-10-28T10:00:00.000Z" }],
  waiting: [{ organizationId: "org_2", organizationName: "Cedar Collective", contactedAt: "2026-11-10T09:00:00.000Z", ownerName: "Sam", followUpAt: "2026-11-21T00:00:00.000Z", activeAgainAt: "2026-11-14T00:00:00.000Z" }],
  results: { days: 30, contacted: 5, replied: 2, quietWhenContacted: 3, cameBack: 1 },
};

test("a row shows the reason, the person and their email without opening anything", () => {
  const html = renderToStaticMarkup(<OutreachList data={data} busy={null} onOutcome={() => { throw new Error("Rendering must not record a step"); }} />);
  for (const text of ["Maple Robotics", "Team, no plan", "3 people ran tasks in the last 14 days, no Team plan", "Ava Chen", "ava@maple.test", "Mark contacted", "Not a fit", "Copy email"]) {
    assert.ok(html.includes(text), `missing: ${text}`);
  }
  assert.ok(html.includes("Cedar Collective") && html.includes("Contacted Nov 10 by Sam"));
  assert.ok(html.includes("Running tasks again since Nov 14"));
  for (const text of ["Left after failures", "Stopped 20 days ago after 4 of 10 tasks failed", "Last task Oct 28", "of 3 that were quiet when contacted", "of 5 contacted"]) {
    assert.ok(html.includes(text), `missing: ${text}`);
  }
  assert.ok(html.includes("2 hidden now"));
  // Reasons nobody matches have no filter.
  assert.ok(!html.includes("Payment failed"));
});

test("the list copies as one tab-separated line per account", () => {
  assert.equal(outreachRowsAsText([item]), [
    "Account\tCompany\tReason\tContact\tEmail\tRole\tPlan\tPeople active",
    "Maple Robotics\tmaple.test\tTeam, no plan: 3 people ran tasks in the last 14 days, no Team plan\tAva Chen\tava@maple.test\tmember\tFree\t3",
  ].join("\n"));
});

test("drafts greet the person and say nothing the recipient cannot already see", () => {
  const team = outreachDraft(item, "Ava Chen");
  assert.ok(team.body.startsWith("Hi Ava,\n\nA few of you in Maple Robotics"));
  const company = outreachDraft({ ...item, play: "company" }, null);
  assert.ok(company.body.startsWith("Hi,") && company.body.includes("If others at maple.test would use it too"));
  assert.ok(!/colleague|\d+ people/.test(company.body));
  const now = new Date("2026-11-17T12:00:00.000Z");
  assert.ok(outreachDraft({ ...item, play: "cancelling", endsAt: "2026-11-30T00:00:00.000Z" }, "Ava", now).body.includes("is set to end on November 30"));
  assert.ok(outreachDraft({ ...item, play: "cancelling", endsAt: "2026-11-03T00:00:00.000Z" }, "Ava", now).body.includes("was canceled"));
  assert.ok(outreachDraft({ ...item, play: "lapsed_failed" }, "Ava").body.includes("didn't complete the last time you used it"));
  assert.ok(outreachDraft({ ...item, play: "lapsed_limit" }, "Ava").body.includes("That limit has reset"));
});
