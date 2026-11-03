import type { ReplayTimeline } from "./harness.ts";

/**
 * Recorded timelines for Your agent: calendar, Gmail and Slack as Connect returns them, with fictional people and
 * companies on `.example` domains. Each says whether the agent should message, and what a good message connects.
 *
 * Times are Eastern (UTC-4 in October). The person works at northwind.example.
 */

const person = { name: "Sam", email: "sam@northwind.example", slackName: "sam" };
const tz = "America/New_York";
const slack = (channel: string, ts: string) => `https://northwind.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
const mail = (id: string) => `https://mail.google.com/mail/u/0/#inbox/${id}`;
const event = (id: string) => `https://calendar.google.com/calendar/event?eid=${id}`;

/** This morning's miss: a customer asks for pricing in Slack before their call; email and calendar alone don't show it. */
const slackAskBeforeCall: ReplayTimeline = {
  id: "slack-ask-before-call",
  title: "A customer asks for pricing in Slack before their 11 AM call",
  now: "2026-10-20T09:40:00-04:00",
  timeZone: tz,
  morning: false,
  person,
  lastReadAt: "2026-10-20T08:05:00-04:00",
  calendar: [
    { id: "evt_standup", title: "Team standup", start: "2026-10-20T10:00:00-04:00", end: "2026-10-20T10:15:00-04:00", organizer: "lee@northwind.example", attendees: [{ email: "lee@northwind.example" }, { email: person.email, self: true, responseStatus: "accepted" }], updated: "2026-10-01T12:00:00Z", htmlLink: event("evt_standup") },
    { id: "evt_renewal", title: "Fabrikam renewal call", start: "2026-10-20T11:00:00-04:00", end: "2026-10-20T11:30:00-04:00", organizer: person.email, attendees: [{ email: person.email, self: true, responseStatus: "accepted" }, { email: "priya@fabrikam.example", responseStatus: "accepted" }, { email: "jordan@fabrikam.example", responseStatus: "accepted" }], updated: "2026-10-14T15:00:00Z", htmlLink: event("evt_renewal") },
  ],
  email: [
    { id: "thr_renewal", subject: "Renewal next steps", link: mail("thr_renewal"), messages: [
      { from: "priya@fabrikam.example", to: person.email, at: "2026-10-16T14:02:00-04:00", text: "Thanks for the demo. We'll come back with seat counts before the renewal call on Tuesday." },
      { from: person.email, to: "priya@fabrikam.example", at: "2026-10-16T15:10:00-04:00", text: "Sounds good, talk Tuesday at 11." },
    ] },
    { id: "thr_digest", subject: "Your weekly product digest", link: mail("thr_digest"), messages: [
      { from: "digest@saas-news.example", to: person.email, at: "2026-10-20T08:30:00-04:00", text: "Top stories this week: ten tips for better dashboards." },
    ] },
  ],
  chat: [
    { channel: "C0FABRIKAM", channelName: "fabrikam-northwind (Slack Connect)", ts: "1792502520.000100", kind: "mention", from: "Priya (fabrikam.example)", at: "2026-10-20T09:22:00-04:00", text: "@sam before our 11 AM call, could you send pricing for 60 seats on the annual plan? Our CFO is joining and wants numbers.", permalink: slack("C0FABRIKAM", "1792502520.000100") },
    { channel: "C0RANDOM", channelName: "random", ts: "1792502700.000200", kind: "thread", from: "Lee (northwind.example)", at: "2026-10-20T09:25:00-04:00", text: "Coffee machine on 3 is fixed.", permalink: slack("C0RANDOM", "1792502700.000200") },
  ],
  expect: {
    kind: "message",
    sources: ["chat"],
    mentions: [
      { pattern: "pricing|price|quote", why: "what was asked (pricing)" },
      { pattern: "11(:00)?\\s?(AM|a\\.m\\.)|the call|your call|renewal call", why: "that it is before the 11 AM call" },
      { pattern: "northwind\\.slack\\.com/archives/C0FABRIKAM", why: "a link to the Slack message" },
    ],
    why: "a customer's ask with a deadline (their call) that only Slack shows",
  },
};

/** Nothing needs them: a newsletter, a receipt, an internal 1:1 later, and a thanks in Slack. */
const quietAfternoon: ReplayTimeline = {
  id: "quiet-afternoon",
  title: "A newsletter, a receipt and a thank-you: nothing needs them",
  now: "2026-10-20T13:40:00-04:00",
  timeZone: tz,
  morning: false,
  person,
  lastReadAt: "2026-10-20T10:40:00-04:00",
  calendar: [
    { id: "evt_1on1", title: "1:1 Lee / Sam", start: "2026-10-20T15:00:00-04:00", end: "2026-10-20T15:30:00-04:00", organizer: "lee@northwind.example", attendees: [{ email: "lee@northwind.example" }, { email: person.email, self: true, responseStatus: "accepted" }], updated: "2026-09-01T12:00:00Z", htmlLink: event("evt_1on1") },
  ],
  email: [
    { id: "thr_news", subject: "October newsletter", link: mail("thr_news"), messages: [{ from: "news@tools-weekly.example", to: person.email, at: "2026-10-20T11:15:00-04:00", text: "This month: new integrations and a webinar." }] },
    { id: "thr_receipt", subject: "Your receipt from Cloud Hosting", link: mail("thr_receipt"), messages: [{ from: "billing@cloudhost.example", to: person.email, at: "2026-10-20T12:02:00-04:00", text: "Payment of $42.00 received. No action needed." }] },
  ],
  chat: [
    { channel: "D0LEE", channelName: "DM with Lee", ts: "1792513200.000300", kind: "dm", from: "Lee (northwind.example)", at: "2026-10-20T12:20:00-04:00", text: "thanks for the notes, got it 👍", permalink: slack("D0LEE", "1792513200.000300") },
  ],
  expect: { kind: "quiet", why: "nothing new needs them" },
};

/** Someone proposes a new time by email; the calendar shows they're already busy then. */
const proposedSlotConflict: ReplayTimeline = {
  id: "proposed-slot-conflict",
  title: "A customer proposes Thursday 3 PM by email; the calendar already has Board prep then",
  now: "2026-10-20T10:20:00-04:00",
  timeZone: tz,
  morning: false,
  person,
  lastReadAt: "2026-10-20T08:05:00-04:00",
  calendar: [
    { id: "evt_review", title: "Contoso quarterly review", start: "2026-10-21T14:00:00-04:00", end: "2026-10-21T15:00:00-04:00", organizer: "dana@contoso.example", attendees: [{ email: "dana@contoso.example", responseStatus: "accepted" }, { email: person.email, self: true, responseStatus: "accepted" }], updated: "2026-10-10T12:00:00Z", htmlLink: event("evt_review") },
    { id: "evt_board", title: "Board prep", start: "2026-10-22T15:00:00-04:00", end: "2026-10-22T16:00:00-04:00", organizer: person.email, attendees: [{ email: person.email, self: true, responseStatus: "accepted" }, { email: "lee@northwind.example", responseStatus: "accepted" }], updated: "2026-10-05T12:00:00Z", htmlLink: event("evt_board") },
  ],
  email: [
    { id: "thr_move", subject: "Re: Contoso quarterly review", link: mail("thr_move"), messages: [
      { from: "dana@contoso.example", to: person.email, at: "2026-10-20T09:55:00-04:00", text: "Something came up tomorrow. Could we move our review to Thursday at 3 PM ET instead? Let me know today if that works." },
    ] },
  ],
  chat: [],
  expect: {
    kind: "message",
    sources: ["email"],
    mentions: [
      { pattern: "Thursday", why: "the proposed day" },
      { pattern: "conflict|overlap|clash|busy|already (have|booked)|Board prep|double", why: "that it collides with Board prep (checked the calendar before endorsing the time)" },
    ],
    why: "a reply due today, and the proposed time collides with their calendar",
  },
};

/** The ask was already handled: they answered in the thread and sent the file by email. */
const alreadyHandled: ReplayTimeline = {
  id: "already-handled",
  title: "A customer's Slack ask the person already answered",
  now: "2026-10-20T15:10:00-04:00",
  timeZone: tz,
  morning: false,
  person,
  lastReadAt: "2026-10-20T12:10:00-04:00",
  calendar: [],
  email: [
    { id: "thr_security", subject: "Security questionnaire", link: mail("thr_security"), messages: [
      { from: person.email, to: "ravi@tailspin.example", at: "2026-10-20T14:34:00-04:00", text: "Hi Ravi, attached is our completed security questionnaire." },
    ] },
  ],
  chat: [
    { channel: "C0TAILSPIN", channelName: "tailspin-northwind (Slack Connect)", ts: "1792519200.000400", kind: "mention", from: "Ravi (tailspin.example)", at: "2026-10-20T14:20:00-04:00", text: "@sam can you share your security questionnaire today?", permalink: slack("C0TAILSPIN", "1792519200.000400"),
      replies: [{ from: "Sam (northwind.example)", at: "2026-10-20T14:35:00-04:00", text: "Sent it over email just now." }, { from: "Ravi (tailspin.example)", at: "2026-10-20T14:40:00-04:00", text: "Got it, thanks!" }] },
  ],
  expect: { kind: "quiet", why: "they already answered and sent it" },
};

/** Something it told them yesterday changed: the meeting it flagged was cancelled. */
const updateToEarlierNote: ReplayTimeline = {
  id: "update-to-earlier-note",
  title: "The meeting it flagged yesterday was cancelled this morning",
  now: "2026-10-20T09:10:00-04:00",
  timeZone: tz,
  morning: false,
  person,
  lastReadAt: "2026-10-20T08:05:00-04:00",
  notes: "# Notes\n- 2026-10-19 4:05 PM: told Sam the Contoso quarterly review moved to Wed Oct 21, 2 PM (calendar event evt_review). Watching it.\n",
  calendar: [
    { id: "evt_review", title: "Contoso quarterly review", start: "2026-10-21T14:00:00-04:00", end: "2026-10-21T15:00:00-04:00", organizer: "dana@contoso.example", attendees: [{ email: "dana@contoso.example" }, { email: person.email, self: true, responseStatus: "accepted" }], status: "cancelled", updated: "2026-10-20T12:48:00Z", htmlLink: event("evt_review") },
  ],
  email: [
    { id: "thr_cancel", subject: "Canceled: Contoso quarterly review", link: mail("thr_cancel"), messages: [
      { from: "dana@contoso.example", to: person.email, at: "2026-10-20T08:48:00-04:00", text: "Sorry, I have to cancel tomorrow's review. I'll send new times next week." },
    ] },
  ],
  chat: [],
  expect: {
    kind: "message",
    mentions: [
      { pattern: "update|change|now cancel|was cancel", why: "that it updates what it said before" },
      { pattern: "cancel", why: "that the review was cancelled" },
    ],
    why: "something it told them yesterday changed",
  },
};

export const REPLAY_TIMELINES: readonly ReplayTimeline[] = [slackAskBeforeCall, quietAfternoon, proposedSlotConflict, alreadyHandled, updateToEarlierNote];
