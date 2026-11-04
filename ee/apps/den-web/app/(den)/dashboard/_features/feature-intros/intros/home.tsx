import { Globe, House, Radar } from "lucide-react";
import { getLibraryMyAgentRoute, getOrgDashboardRoute, getWebRoute } from "../../../../_lib/den-org";
import { defineFeatureIntro } from "../types";
import { OPENWORK_INSTALL_ROUTE } from "./analytics";
import { docsPage } from "./docs";
import { HomeExample } from "./examples/home/home-example";
import { MyBotExample } from "./examples/my-bot/my-bot-example";
import { WebExample } from "./examples/web/web-example";
import { MEMBERS_INVITE_ROUTE } from "./members";

/*
 * Work-section pages whose intro answers `?` only: each page already is its
 * own next step, so none of them ever gives way to an intro.
 * - Home: admins get the overview (people, invites, activity), members a page
 *   whose one action is getting the app. An intro there would push the same
 *   action twice and hide the overview.
 * - OpenWork Web: the page is the purchase or "Open OpenWork Web" step, and
 *   checkout is a request, not a link an intro could make.
 * - My bot: its switch, hours and sources are the setup, on the page itself.
 */
export const homeIntros = [
  defineFeatureIntro({
    key: "home",
    version: 1,
    match: { path: getOrgDashboardRoute() },
    icon: House,
    title: "Home",
    summary: "Your organization's OpenWork: who uses it, and what everyone gets when they sign in.",
    highlights: [
      { title: "Set it up once.", text: "Models, connectors and plugins you share reach people as soon as they sign in to OpenWork." },
      { title: "See who's in.", text: "People, open invitations and recent activity at a glance." },
      { title: "Members just download.", text: "Everyone else gets the app, signs in and starts with your setup." },
    ],
    example: {
      Component: HomeExample,
      alt: "Example: Acme with 18 of 24 people active this week, Claude Sonnet 5 and GPT-6 Luna, Google Workspace, Slack and Linear for everyone, and two plugins.",
    },
    docsUrl: docsPage("cloud/team-quickstart"),
    ctas: [
      { when: (ctx) => ctx.can("canInviteMembers"), label: "Invite your team", href: MEMBERS_INVITE_ROUTE },
      { when: () => true, label: "Download OpenWork", href: OPENWORK_INSTALL_ROUTE },
    ],
    setupState: () => "done",
  }),

  defineFeatureIntro({
    key: "web",
    version: 1,
    match: { path: getWebRoute() },
    icon: Globe,
    title: "OpenWork Web",
    summary: "Use OpenWork in your browser, with your team's models and apps and nothing to install.",
    highlights: [
      { title: "Nothing to install.", text: "Open it in a browser and sign in with your OpenWork account." },
      { title: "Your team's setup.", text: "The models, connectors and plugins your organization shares with you." },
      { title: "Cloud Automations.", text: "Scheduled tasks you create in OpenWork Web run there." },
      { title: "One subscription.", text: "An owner or admin turns it on, and every member gets it." },
    ],
    example: {
      Component: WebExample,
      alt: "Example: in OpenWork Web, someone asks for a summary of this week in #launch. It reads #launch in Slack, finds the launch plan in Drive and drafts the update.",
    },
    docsUrl: docsPage("cloud/run-in-the-cloud/open-cloud-in-browser"),
    // The page's purchase or open button is the action; an intro link can't start checkout.
    ctas: [],
    setupState: () => "done",
  }),

  defineFeatureIntro({
    key: "my-bot",
    version: 1,
    match: { path: getLibraryMyAgentRoute() },
    icon: Radar,
    title: "My bot",
    summary: "Keeps an eye on your email, calendar and team chat, and tells you what needs you.",
    highlights: [
      { title: "In your hours.", text: "It checks during the working hours you set, and stays quiet otherwise." },
      { title: "Only what matters.", text: "Choose what it tells you about, and say in your own words what counts." },
      { title: "A message in Slack.", text: "Link your Slack account to Workbot to get its messages." },
      { title: "Within your organization's limits.", text: "Your admin sets the hours and how many messages a day it can send." },
    ],
    example: {
      Component: MyBotExample,
      alt: "Example: last check 9:30 AM found two things that need you. Today's checks at 9:30, 11:30 and 1:30, two sent in Slack. It reads Gmail, Google Calendar and Slack.",
    },
    // No My bot page in the docs yet: linking Slack is what makes its messages arrive.
    docsUrl: docsPage("slack/connect-your-account"),
    // The switch at the top of the page is the action.
    ctas: [],
    setupState: () => "done",
  }),
];
