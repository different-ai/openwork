import type { DayChatMessage, DayEmailThread, DayEvent, DayGithubItem, DayScenario } from "./day.ts";

/**
 * Recorded days for Your agent's replay evals (agent-brief-replay.ts). Fictional people and companies on `.example`
 * domains: Sam Rivera works at Acme Robotics (acme.example) with Lee Park; customers are Northwind Labs, Fabrikam and
 * Tailspin. Times are Eastern (UTC-4 in October). Wednesday 2026-10-21, and Thursday 2026-10-22 for the two-day one.
 *
 * Each scenario says what must be told and by when (a check at or before that time), what may be mentioned, and what
 * is never worth a message. A quiet scenario expects no message at all.
 */

const person = { name: "Sam Rivera", first: "Sam", email: "sam@acme.example", slackName: "sam" };
const tz = "America/New_York";
const D1 = "2026-10-21";
const D2 = "2026-10-22";
const t = (day: string, time: string) => `${day}T${time}:00-04:00`;
const slack = (channel: string, ts: string) => `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
const mail = (id: string) => `https://mail.google.com/mail/u/0/#inbox/${id}`;
const event = (id: string) => `https://calendar.google.com/calendar/event?eid=${id}`;
const me = { email: person.email, self: true, responseStatus: "accepted" as const };

function meeting(id: string, title: string, start: string, end: string, organizer: string, others: string[], extra: Partial<DayEvent> = {}): DayEvent {
  return { id, title, start, end, organizer, attendees: [me, ...others.map((email) => ({ email, responseStatus: "accepted" as const }))], updated: "2026-10-10T12:00:00Z", htmlLink: event(id), ...extra };
}
function thread(id: string, subject: string, messages: DayEmailThread["messages"]): DayEmailThread {
  return { id, subject, link: mail(id), messages };
}
function chat(channel: string, channelName: string, ts: string, kind: DayChatMessage["kind"], from: string, at: string, text: string, replies?: DayChatMessage["replies"]): DayChatMessage {
  return { channel, channelName, ts, kind, from, at, text, permalink: slack(channel, ts), ...(replies ? { replies } : {}) };
}
function github(item: Omit<DayGithubItem, "url" | "id"> & { kind?: "pull" | "issues" | "security" }): DayGithubItem {
  const path = item.type === "PullRequest" ? "pull" : item.type === "Issue" ? "issues" : "security/secret-scanning";
  return { ...item, id: `${item.repo}#${item.number}`, url: `https://github.com/${item.repo}/${path}/${item.number}` };
}

const newsletter = (id: string, at: string, from: string, subject: string) => thread(id, subject, [{ from, to: person.email, at, text: `${subject}: this week's top stories, a webinar invite and product tips. Unsubscribe anytime.` }]);
const renderAlert = (at: string) => thread("thr_render", "Bandwidth usage alert for acme-api", [{ from: "billing@render.example", to: person.email, at, text: "Your service acme-api has used 731 GB of its 1,024 GB monthly bandwidth allowance. At the current rate it will run out around Nov 10; overage is billed at $0.15 per GB. Manage your plan: https://dashboard.render.example/billing" }]);

/** A busy first check: a deadline today, someone missing from a meeting invite, a cost risk, and noise. */
const busyMorning: DayScenario = {
  id: "busy-morning",
  title: "Busy morning: SOW due at noon, Priya missing from the 10:30 invite, a bandwidth bill, newsletters",
  person, timeZone: tz,
  windows: [{ date: D1, from: 8, to: 13 }],
  calendar: [meeting("evt_kickoff", "Northwind kickoff", t(D1, "10:30"), t(D1, "11:00"), person.email, ["lee@acme.example", "dana@northwind.example"])],
  email: [
    thread("thr_sow", "Countersigned SOW", [{ from: "dana@northwind.example", to: person.email, at: t("2026-10-20", "18:40"), text: "Hi Sam, could you send the countersigned SOW by noon tomorrow? Our legal team closes the quarter's paperwork at 1 PM. Thanks, Dana" }]),
    renderAlert(t(D1, "07:10")),
    newsletter("thr_news", t(D1, "06:30"), "news@robotics-weekly.example", "This week in robotics"),
    thread("thr_ci", "[acme/robot-api] CI passed on main", [{ from: "ci@acme.example", to: person.email, at: t(D1, "07:55"), text: "All 412 checks passed on main (commit 9ab12f)." }]),
  ],
  chat: [
    chat("C0NORTH", "acme-northwind (Slack Connect)", "1792583520.000100", "mention", "Priya (northwind.example)", t(D1, "07:52"), "@sam could you add me to the 10:30 kickoff? I'm running the integration on our side and I'm not on the invite."),
    chat("D0LEE", "DM with Lee", "1792585800.000200", "dm", "Lee (acme.example)", t(D1, "08:30"), "morning! ☕"),
  ],
  expect: {
    must: [
      { id: "sow", match: "SOW|statement of work", by: t(D1, "10:00"), why: "Dana needs the countersigned SOW by noon" },
      { id: "priya-invite", match: "Priya", by: t(D1, "10:00"), why: "Priya isn't on the 10:30 kickoff invite" },
      { id: "bandwidth", match: "Render|731|bandwidth|1,024", by: t(D1, "12:00"), why: "the bandwidth allowance runs out around Nov 10" },
    ],
    never: [{ match: "robotics weekly|This week in robotics|newsletter|CI passed|412 checks", why: "newsletters and routine notifications" }],
  },
};

/** Nothing needs Sam: routine mail, internal meetings, a thank-you. */
const quietDay: DayScenario = {
  id: "quiet-day",
  title: "Quiet day: a newsletter, a receipt, a digest, a thank-you and internal meetings",
  person, timeZone: tz,
  windows: [{ date: D1, from: 8, to: 15 }],
  calendar: [
    meeting("evt_standup", "Team standup", t(D1, "09:30"), t(D1, "09:45"), "lee@acme.example", ["lee@acme.example", "mo@acme.example"]),
    meeting("evt_1on1", "1:1 Lee / Sam", t(D1, "15:00"), t(D1, "15:30"), "lee@acme.example", ["lee@acme.example"]),
  ],
  email: [
    newsletter("thr_news", t(D1, "07:15"), "news@tools-weekly.example", "October tools newsletter"),
    thread("thr_receipt", "Your receipt from Cloud Hosting", [{ from: "billing@cloudhost.example", to: person.email, at: t(D1, "09:02"), text: "Payment of $42.00 received for October. No action needed." }]),
    thread("thr_digest", "Your weekly project digest", [{ from: "digest@tracker.example", to: person.email, at: t(D1, "11:00"), text: "3 issues closed, 2 opened in Robot API this week." }]),
  ],
  chat: [
    chat("D0LEE", "DM with Lee", "1792587600.000300", "dm", "Lee (acme.example)", t(D1, "09:40"), "thanks for the notes, got it 👍"),
    chat("C0GENERAL", "general", "1792596000.000400", "mention", "Mo (acme.example)", t(D1, "12:00"), "@here lunch is in the kitchen"),
  ],
  expect: { must: [], silent: true, never: [{ match: ".", why: "nothing needs Sam today" }] },
};

/** A customer asks in Slack for pricing before their 11 AM call; email and calendar alone don't show it. */
const slackAskBeforeMeeting: DayScenario = {
  id: "slack-ask-before-meeting",
  title: "A customer's Slack ask for pricing before the 11 AM call",
  person, timeZone: tz,
  windows: [{ date: D1, from: 8, to: 12 }],
  calendar: [meeting("evt_renewal", "Fabrikam renewal call", t(D1, "11:00"), t(D1, "11:30"), person.email, ["priya@fabrikam.example", "jordan@fabrikam.example"])],
  email: [
    thread("thr_renewal", "Renewal next steps", [
      { from: "priya@fabrikam.example", to: person.email, at: t("2026-10-16", "14:02"), text: "Thanks for the demo. We'll come back with seat counts before the renewal call on Wednesday." },
      { from: person.email, to: "priya@fabrikam.example", at: t("2026-10-16", "15:10"), text: "Sounds good, talk Wednesday at 11." },
    ]),
    newsletter("thr_digest", t(D1, "08:30"), "digest@saas-news.example", "Your weekly product digest"),
  ],
  chat: [
    chat("C0FABRIKAM", "fabrikam-acme (Slack Connect)", "1792588920.000100", "mention", "Priya (fabrikam.example)", t(D1, "09:22"), "@sam before our 11 AM call, could you send pricing for 60 seats on the annual plan? Our CFO is joining and wants numbers."),
    chat("C0RANDOM", "random", "1792589100.000200", "thread", "Lee (acme.example)", t(D1, "09:25"), "Coffee machine on 3 is fixed."),
  ],
  expect: {
    must: [{ id: "pricing", match: "pricing|60 seats|price|quote", by: t(D1, "10:45"), why: "Priya wants pricing for 60 seats before the 11 AM call" }],
    never: [{ match: "coffee|digest", why: "noise" }],
  },
};

/** "I'll handle it after lunch": no repeat at noon; a nudge after lunch once Lee asks again. */
const handleAfterLunch: DayScenario = {
  id: "handle-after-lunch",
  title: "\"I'll handle it after lunch\", then Lee asks again at 1:30",
  person, timeZone: tz,
  windows: [{ date: D1, from: 9, to: 15 }],
  calendar: [],
  email: [thread("thr_redlines", "Northwind MSA redlines v3", [{ from: "legal@acme.example", to: `${person.email}, lee@acme.example`, at: t(D1, "09:05"), text: "Attached are Northwind's redlines (v3). Sam, we need your comments on sections 4 and 9 by 3 PM today to send our response." }])],
  chat: [chat("D0LEE", "DM with Lee", "1792587000.000500", "dm", "Lee (acme.example)", t(D1, "09:10"), "Can you review the Northwind contract redlines today? Legal needs your comments on sections 4 and 9 by 3 PM.", [{ from: "Lee (acme.example)", at: t(D1, "13:30"), text: "Any update on the redlines? Legal is asking again." }])],
  memberSays: [{ at: t(D1, "10:20"), text: "Thanks, I'll handle the redlines after lunch." }],
  expect: {
    must: [{ id: "redlines", match: "redline|sections 4 and 9|MSA", by: t(D1, "10:00"), why: "legal needs comments by 3 PM", again: { after: t(D1, "13:30"), by: t(D1, "14:00") } }],
  },
};

/** An exposed key, still unresolved the next morning. */
const securityTwoDays: DayScenario = {
  id: "security-two-days",
  title: "An exposed AWS key in auth/keys.ts, still unresolved the next morning",
  person, timeZone: tz,
  windows: [{ date: D1, from: 10, to: 15 }, { date: D2, from: 8, to: 11 }],
  calendar: [],
  email: [newsletter("thr_news", t(D2, "07:00"), "news@devops-digest.example", "DevOps digest")],
  chat: [chat("C0SECURITY", "security", "1792593720.000600", "mention", "security-bot (acme.example)", t(D1, "10:42"), "New secret scanning alert in acme/robot-api: AWS access key in auth/keys.ts. Assigned: @sam")],
  github: [
    github({ repo: "acme/robot-api", type: "SecurityAlert", number: 41, title: "AWS access key exposed in auth/keys.ts", reason: "security_alert", at: t(D1, "10:40"), state: "open", body: "Secret scanning found an AWS access key (AKIA…7QZ) committed to auth/keys.ts on main in commit 3f9c2e1. Rotate the key in AWS and remove it from the file and history. Assigned to sam." }),
    github({ repo: "acme/robot-api", type: "PullRequest", number: 815, title: "Bump lodash from 4.17.20 to 4.17.21", reason: "subscribed", at: t(D2, "06:10"), state: "open", body: "Dependabot: bumps lodash." }),
  ],
  expect: {
    must: [{ id: "key", match: "key|secret|auth/keys|AKIA", by: t(D1, "12:00"), why: "an exposed credential, assigned to Sam", again: { after: t(D2, "07:00"), by: t(D2, "08:00") } }],
    never: [{ match: "lodash|dependabot|DevOps digest", why: "routine" }],
  },
};

/** Lots worth telling, then an outage late in the day: the last message of the day has to be there for it. */
const capExhaustion: DayScenario = {
  id: "cap-exhaustion",
  title: "Five things worth telling in the morning, a customer blocked by a 500 at 3:05 PM",
  person, timeZone: tz,
  windows: [{ date: D1, from: 8, to: 18 }],
  calendar: [meeting("evt_northwind", "Northwind planning", t(D2, "11:00"), t(D2, "12:00"), "dana@northwind.example", ["dana@northwind.example", "lee@acme.example"])],
  email: [
    thread("thr_quote", "Revised quote", [{ from: "dana@northwind.example", to: person.email, at: t("2026-10-20", "17:00"), text: "Could you send a revised quote for 40 robots by Friday? Finance wants it before month end." }]),
    thread("thr_invoice", "Invoice #2231 from Fabrikam", [{ from: "ar@fabrikam.example", to: person.email, at: t(D1, "07:30"), text: "Invoice #2231 for $18,400 is due Oct 30." }]),
    renderAlert(t(D1, "07:10")),
    thread("thr_call", "A call next week?", [{ from: "priya@fabrikam.example", to: person.email, at: t(D1, "12:40"), text: "Could we find 30 minutes next week to talk about the Q1 rollout?" }]),
    thread("thr_errors", "[Alert] acme-api error rate 38% on /v2/orders", [{ from: "alerts@monitoring.example", to: person.email, at: t(D1, "15:12"), text: "acme-api: error rate 38% on POST /v2/orders since 15:05 (HTTP 500). On-call: sam." }]),
  ],
  chat: [
    chat("D0LEE", "DM with Lee", "1792583400.000700", "dm", "Lee (acme.example)", t(D1, "07:50"), "When you get a chance this week, could you give feedback on the hiring rubric doc?"),
    chat("C0NORTH", "acme-northwind (Slack Connect)", "1792610400.000800", "mention", "Dana (northwind.example)", t(D1, "15:20"), "@sam urgent: our production deploy is failing — your API returns 500 on /v2/orders since 3:05 PM. We're blocked."),
  ],
  expect: {
    must: [{ id: "outage", match: "500|outage|error rate|/v2/orders|blocked", by: t(D1, "16:00"), why: "a customer is blocked by a production error" }],
    ok: [{ match: "quote|rubric|invoice|2231|Render|bandwidth|731|planning|prep|call next week|Q1", why: "worth telling, not required" }],
  },
};

/** Noise all morning; one automated email carries a real deadline risk. */
const noiseDomain: DayScenario = {
  id: "noise-and-one-risk",
  title: "Newsletters and automated notices, and one that matters: the domain's auto-renew failed",
  person, timeZone: tz,
  windows: [{ date: D1, from: 8, to: 13 }],
  calendar: [],
  email: [
    newsletter("thr_n1", t(D1, "06:00"), "news@robotics-weekly.example", "Robotics weekly"),
    newsletter("thr_n2", t(D1, "07:20"), "hello@design-tips.example", "Design tips #88"),
    newsletter("thr_n3", t(D1, "10:05"), "news@ai-briefing.example", "The AI briefing"),
    thread("thr_ci1", "[acme/robot-api] CI passed on main", [{ from: "ci@acme.example", to: person.email, at: t(D1, "08:10"), text: "All checks passed." }]),
    thread("thr_figma", "Your invoice from Figma is available", [{ from: "billing@figma.example", to: person.email, at: t(D1, "09:00"), text: "Your October invoice for $45.00 is available. It will be charged automatically." }]),
    thread("thr_accept", "Accepted: 1:1 Lee / Sam", [{ from: "lee@acme.example", to: person.email, at: t(D1, "09:15"), text: "Lee accepted this invitation." }]),
    thread("thr_domain", "Action required: auto-renew failed for acme-robotics.example", [{ from: "support@registrar.example", to: person.email, at: t(D1, "07:40"), text: "We couldn't renew acme-robotics.example: the card ending 4421 was declined. The domain expires on Oct 24; after that your website and email stop working. Update your payment method to renew." }]),
  ],
  chat: [chat("C0GENERAL", "general", "1792590000.000900", "mention", "Mo (acme.example)", t(D1, "09:00"), "@channel reminder: all-hands Friday at 4")],
  expect: {
    must: [{ id: "domain", match: "domain|acme-robotics\\.example|auto-renew|renew", by: t(D1, "10:00"), why: "the company domain expires in three days" }],
    never: [{ match: "newsletter|weekly|Design tips|AI briefing|CI|Figma|accepted|all-hands", why: "routine" }],
  },
};

/** Someone else moved a meeting into Sam's afternoon, on top of another one. */
const calendarConflict: DayScenario = {
  id: "calendar-change-conflict",
  title: "Northwind moved tomorrow's 10 AM review to today at 3 PM, on top of Sam's 1:1",
  person, timeZone: tz,
  windows: [{ date: D1, from: 8, to: 13 }],
  calendar: [
    meeting("evt_review", "Northwind quarterly review", t(D2, "10:00"), t(D2, "11:00"), "dana@northwind.example", ["dana@northwind.example", "lee@acme.example"]),
    meeting("evt_review", "Northwind quarterly review", t(D1, "15:00"), t(D1, "16:00"), "dana@northwind.example", ["dana@northwind.example", "lee@acme.example"], { visibleAt: t(D1, "09:35"), updated: "2026-10-21T13:35:00Z", change: { kind: "moved", previousStart: t(D2, "10:00") } }),
    meeting("evt_1on1", "1:1 Lee / Sam", t(D1, "15:00"), t(D1, "15:30"), "lee@acme.example", ["lee@acme.example"]),
  ],
  email: [thread("thr_moved", "Updated invitation: Northwind quarterly review", [{ from: "dana@northwind.example", to: person.email, at: t(D1, "09:36"), text: "Moved our review to today at 3 PM, sorry for the short notice — our VP travels tomorrow." }])],
  chat: [],
  expect: {
    must: [{ id: "moved", match: "review.*(3|15)|moved|today at 3|3 PM|3:00", by: t(D1, "12:00"), why: "the review moved into today, on top of the 1:1" }],
  },
};

/** A commitment Sam made is due today, and nothing was sent yet. */
const commitmentDue: DayScenario = {
  id: "commitment-due",
  title: "Sam promised the updated deck by today; Dana presents it tomorrow at 9",
  person, timeZone: tz,
  // An end-of-day deadline: telling it by early afternoon still leaves time to do the work.
  windows: [{ date: D1, from: 8, to: 15 }],
  calendar: [],
  email: [
    thread("thr_deck", "Updated deck", [
      { from: "dana@northwind.example", to: person.email, at: t("2026-10-19", "15:30"), text: "Could we get the updated deck with the new pricing slide?" },
      { from: person.email, to: "dana@northwind.example", at: t("2026-10-19", "16:00"), text: "Yes — I'll send the updated deck by Wednesday EOD." },
      { from: "dana@northwind.example", to: person.email, at: t(D1, "08:20"), text: "Looking forward to the deck today — I'm presenting it to our VP tomorrow at 9." },
    ]),
    newsletter("thr_news", t(D1, "07:00"), "news@saas-news.example", "SaaS news"),
  ],
  chat: [],
  expect: {
    must: [{ id: "deck", match: "deck", by: t(D1, "14:00"), why: "Sam promised the deck by the end of today and hasn't sent it" }],
    never: [{ match: "SaaS news|newsletter", why: "noise" }],
  },
};

/** Something told yesterday changed; an ask was already answered. */
const updateAndHandled: DayScenario = {
  id: "update-and-handled",
  title: "Yesterday's flagged review was cancelled; a Slack ask was already answered",
  person, timeZone: tz,
  windows: [{ date: D1, from: 9, to: 13 }],
  notes: "# Notes\n- 2026-10-20 4:05 PM: told Sam the Contoso quarterly review moved to Thu Oct 22, 2 PM (calendar event evt_contoso). Watching it.\n",
  calendar: [
    meeting("evt_contoso", "Contoso quarterly review", t(D2, "14:00"), t(D2, "15:00"), "dana@contoso.example", ["dana@contoso.example"]),
    meeting("evt_contoso", "Contoso quarterly review", t(D2, "14:00"), t(D2, "15:00"), "dana@contoso.example", ["dana@contoso.example"], { visibleAt: t(D1, "08:48"), status: "cancelled", updated: "2026-10-21T12:48:00Z", change: { kind: "cancelled" } }),
  ],
  email: [
    thread("thr_cancel", "Canceled: Contoso quarterly review", [{ from: "dana@contoso.example", to: person.email, at: t(D1, "08:48"), text: "Sorry, I have to cancel Thursday's review. I'll send new times next week." }]),
    thread("thr_questionnaire", "Security questionnaire", [{ from: person.email, to: "ravi@tailspin.example", at: t(D1, "09:34"), text: "Hi Ravi, attached is our completed security questionnaire." }]),
  ],
  chat: [chat("C0TAILSPIN", "tailspin-acme (Slack Connect)", "1792588800.001000", "mention", "Ravi (tailspin.example)", t(D1, "09:20"), "@sam can you share your security questionnaire today?", [{ from: "Sam (acme.example)", at: t(D1, "09:35"), text: "Sent it over email just now." }, { from: "Ravi (tailspin.example)", at: t(D1, "09:40"), text: "Got it, thanks!" }])],
  expect: {
    must: [{ id: "cancelled", match: "cancel", by: t(D1, "10:00"), why: "what it told Sam yesterday changed" }],
    never: [{ match: "questionnaire", why: "already answered" }],
  },
};

/** A review request becomes a blocker for a release cut; Dependabot and a typo issue are noise. */
const reviewBlocker: DayScenario = {
  id: "review-blocks-release",
  title: "PR #812 becomes the last blocker for the 2 PM release cut",
  person, timeZone: tz,
  windows: [{ date: D1, from: 9, to: 15 }],
  calendar: [],
  email: [],
  chat: [],
  github: [
    github({ repo: "acme/robot-api", type: "PullRequest", number: 812, title: "Fix order sync retries", reason: "review_requested", at: t(D1, "09:00"), state: "open", body: "Retries failed order syncs with backoff. Requested review from sam.", comments: [{ from: "lee", at: t(D1, "11:10"), text: "@sam this is the last blocker for the 2 PM release cut — can you review before 1?" }] }),
    github({ repo: "acme/robot-api", type: "PullRequest", number: 813, title: "Bump axios from 1.6.0 to 1.6.1", reason: "subscribed", at: t(D1, "09:30"), state: "open", body: "Dependabot: bumps axios." }),
    github({ repo: "acme/docs", type: "Issue", number: 77, title: "Typo in the setup guide", reason: "assign", at: t(D1, "09:15"), state: "open", body: "\"recieve\" should be \"receive\"." }),
  ],
  expect: {
    // The review request alone is fine to mention; what must reach Sam is that it now blocks the release cut.
    must: [{ id: "pr812-blocker", match: "blocker|release cut|before 1", by: t(D1, "12:00"), why: "Lee is blocked on Sam's review before the 2 PM cut" }],
    ok: [{ match: "#?812|order sync", why: "the review request itself" }],
    never: [{ match: "axios|dependabot|#813|typo|#77", why: "routine" }],
  },
};

/** Sam asked not to hear about hosting bills; nothing else needs them. */
const askedNotTo: DayScenario = {
  id: "asked-not-to",
  title: "A hosting bill alert Sam asked not to hear about; nothing else",
  person, timeZone: tz,
  windows: [{ date: D1, from: 8, to: 13 }],
  memberLines: "Never tell me about hosting or bandwidth bills; Dana Ortiz in finance watches them.",
  memberWords: { never: "hosting or bandwidth bills; Dana Ortiz in finance watches them" },
  calendar: [meeting("evt_standup", "Team standup", t(D1, "09:30"), t(D1, "09:45"), "lee@acme.example", ["lee@acme.example"])],
  email: [renderAlert(t(D1, "07:10")), newsletter("thr_news", t(D1, "06:30"), "news@robotics-weekly.example", "This week in robotics")],
  chat: [],
  expect: { must: [], silent: true, never: [{ match: ".", why: "Sam asked not to hear about hosting bills" }] },
};

export const DAY_SCENARIOS: readonly DayScenario[] = [
  busyMorning, quietDay, slackAskBeforeMeeting, handleAfterLunch, securityTwoDays, capExhaustion,
  noiseDomain, calendarConflict, commitmentDue, updateAndHandled, reviewBlocker, askedNotTo,
];
