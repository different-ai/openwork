import { Compass, KeyRound, Laptop, Layers, MessageCircle, ScrollText, ShieldCheck, SquareTerminal, Users } from "lucide-react";
import { getAiGatewayProvidersRoute, getMembersRoute, getNewAiGatewayProviderRoute, getNewRoleRoute, getPluginsRoute, permissionLockReason } from "../../../../_lib/den-org";
import { defineFeatureIntro } from "../types";
import { docsPage } from "./docs";
import { PromptCardsExample } from "./examples/members/prompt-cards-example";
import { RolesExample } from "./examples/members/roles-example";
import { TeamAccessExample } from "./examples/members/team-access-example";
import { TeamAgentsExample, TeamBrowserExample } from "./examples/members/team-agents-example";
import { TeamMembersExample } from "./examples/members/team-members-example";
import { TeamModelsExample } from "./examples/members/team-models-example";
import { TeamPromptExample } from "./examples/members/team-prompt-example";
import { TeamWorkbotExample } from "./examples/members/team-workbot-example";

/**
 * Facts a team's page (and Everyone's, which shares these tabs) reports from
 * data its tabs already load. A missing fact means "not loaded yet", which
 * shows nothing: a tab never swaps its content for an intro on a guess.
 */
export type TeamDetailFacts = {
  /** People in the team (Members tab). */
  teamMembers?: number;
  managedByScim?: boolean;
  /** The team grants organization Admin, so changing who's in it needs Manage Admin teams. */
  adminTeam?: boolean;
  /** Plugins the team can use, any source (Access tab, `GET /v1/teams/:id/plugin-access`). */
  plugins?: number;
  /** AI Gateway providers and OpenWork Models (Models tab), as the AI Gateway intro reads them. */
  providers?: number;
  openworkModels?: boolean;
  /** Providers this team can use through any grant; only reported on a team's page. */
  sharedProviders?: number;
  /** A system prompt applies here: this scope's own, or Everyone's on a team (Prompts tab). */
  hasPrompt?: boolean;
  /** The viewer may write prompts (`canEdit` from `GET /v1/org/prompts`). */
  canEditPrompts?: boolean;
};

/** Teams and Everyone share one path pattern; the literal Everyone path falls back to it. */
const PATH = `${getMembersRoute()}/teams/:teamId`;
const DOCS = "cloud/members-and-rbac";
const AGENT_DOCS = "cloud/share-with-your-team/agent-permissions";
/** Same page, Members tab: the team page sends this on to the team's edit form (DESIGN.md I5). */
const ADD_PEOPLE = "?tab=overview&addPeople=1";
/** Same page, Prompts tab with the editor open. */
const WRITE_PROMPT = "?tab=prompts&write=1";

export const teamDetailIntros = [
  defineFeatureIntro<TeamDetailFacts>({
    key: "team-detail.role",
    parent: "members.teams",
    version: 1,
    match: { path: PATH, tab: "role" },
    icon: ShieldCheck,
    title: "Role",
    summary: "What the people in a team can do in your organization, on top of what everyone can.",
    highlights: [
      { title: "Member, Admin or custom.", text: "Member adds nothing. Admin makes everyone in the team an admin. A custom role adds the permissions you choose." },
      { title: "Admin teams are approved.", text: "By default, only the owner can make a team an Admin team." },
      { title: "Everyone is the base.", text: "Every person in the organization has the Member role, whatever their teams." },
    ],
    example: {
      Component: RolesExample,
      alt: "Example: a Team lead role on Engineering and Sales that adds Invite people, Share with everyone and View usage analytics, next to the built-in Owner, Admin and Member roles.",
    },
    docsUrl: docsPage(`${DOCS}#roles`),
    ctas: [
      { when: (ctx) => ctx.can("canManagePermissions") && ctx.can("canManageTeams"), label: "Create a custom role", href: getNewRoleRoute() },
      { when: () => true, label: "Create a custom role", href: getNewRoleRoute(), locked: { reason: permissionLockReason("permissions.manage") } },
    ],
    // Every team always has a role: `?` only.
    setupState: () => "done",
  }),

  defineFeatureIntro<TeamDetailFacts>({
    key: "team-detail.members",
    parent: "members.teams",
    version: 1,
    match: { path: PATH, tab: "overview" },
    icon: Users,
    title: "Team members",
    summary: "Everyone you add gets this team's role and everything shared with it.",
    highlights: [
      { title: "Shared with the team.", text: "AI providers, plugins and connectors given to this team reach everyone in it." },
      { title: "Several teams at once.", text: "People can be in more than one team and get what each one is given." },
      { title: "Taking someone out.", text: "They lose what this team gave them, unless another team or grant gives it too." },
    ],
    example: {
      Component: TeamMembersExample,
      alt: "Example: Grace Hopper, Linus Torvalds and Maya Chen in Engineering, each getting Anthropic, OpenAI, GitHub, Linear and the Release notes and Code review plugins.",
    },
    docsUrl: docsPage(`${DOCS}#create-teams`),
    ctas: [
      { when: (ctx) => ctx.facts.managedByScim === true, label: "Add people to this team", href: ADD_PEOPLE, locked: { reason: "Managed by your identity provider. Change who's in this team there." } },
      { when: (ctx) => ctx.facts.adminTeam === true && !ctx.can("canManageAdminTeams"), label: "Add people to this team", href: ADD_PEOPLE, locked: { reason: permissionLockReason("teams.manage_admin") } },
      { when: (ctx) => ctx.can("canManageTeams"), label: "Add people to this team", href: ADD_PEOPLE },
      { when: () => true, label: "Add people to this team", href: ADD_PEOPLE, locked: { reason: permissionLockReason("teams.manage") } },
    ],
    setupState: (ctx) => {
      if (ctx.facts.teamMembers === undefined) return "done";
      return ctx.facts.teamMembers > 0 ? "done" : "none";
    },
  }),

  defineFeatureIntro<TeamDetailFacts>({
    key: "team-detail.access",
    parent: "members.teams",
    version: 1,
    match: { path: PATH, tab: "access" },
    icon: KeyRound,
    title: "Team access",
    summary: "Give this team the plugins it needs, with nothing for anyone in it to install.",
    highlights: [
      { title: "Share from the plugin.", text: "On a plugin's page, add this team to who can use it." },
      { title: "Every source in one list.", text: "Plugins shared with this team, with everyone or through a catalog all show here." },
      { title: "Ready in their Library.", text: "People in the team find them in OpenWork, and the AI uses them when a request matches." },
    ],
    example: {
      Component: TeamAccessExample,
      alt: "Example: Sales can use Sales playbook shared with the team, Brand voice shared with everyone and Deal desk through the Revenue catalog.",
    },
    docsUrl: docsPage("start-here/do-work-with-it/publish-and-copy-a-skill#2-choose-who-can-use-it"),
    // Anyone can create a plugin and share their own, so there is no locked variant.
    ctas: [{ when: () => true, label: "Share a plugin", href: getPluginsRoute() }],
    setupState: (ctx) => {
      if (ctx.facts.plugins === undefined) return "done";
      return ctx.facts.plugins > 0 ? "done" : "none";
    },
  }),

  defineFeatureIntro<TeamDetailFacts>({
    key: "team-detail.agents",
    parent: "members.teams",
    version: 1,
    match: { path: PATH, tab: "agents" },
    icon: SquareTerminal,
    title: "Agent permissions",
    summary: "Choose what agents can do on people's computers, for everyone or for one team.",
    highlights: [
      { title: "Allow, ask first or block.", text: "Set it for running commands and editing files, with commands that are always allowed or always blocked." },
      { title: "Teams change Everyone's.", text: "A team's choice replaces Everyone's for its members, and its lists add to Everyone's." },
      { title: "The strictest wins.", text: "Someone in several teams gets the strictest choice among them." },
    ],
    example: {
      Component: TeamAgentsExample,
      alt: "Example: for Contractors, run commands asks first except git and npm test, editing files follows Everyone, and local MCP servers are blocked.",
    },
    docsUrl: docsPage(AGENT_DOCS),
    // The tab is the editor, and "Follows Everyone" is a valid state: `?` only.
    ctas: [],
    setupState: () => "done",
  }),

  defineFeatureIntro<TeamDetailFacts>({
    key: "team-detail.browser",
    parent: "members.teams",
    version: 1,
    match: { path: PATH, tab: "browser" },
    icon: Compass,
    title: "Browser",
    summary: "Choose which websites agents and the built-in browser can open.",
    highlights: [
      { title: "Allow, ask first or block.", text: "With ask first, the person approves a website before it opens." },
      { title: "Lists of websites.", text: "Always allow or always block a site, its subdomains or some of its pages." },
      { title: "Blocked means blocked.", text: "A blocked website doesn't load in the built-in browser, and the browser says why." },
    ],
    example: {
      Component: TeamBrowserExample,
      alt: "Example: for Contractors, opening websites asks first, docs.acme.com is always allowed and a file sharing site is always blocked.",
    },
    docsUrl: docsPage(`${AGENT_DOCS}#patterns`),
    ctas: [],
    setupState: () => "done",
  }),

  defineFeatureIntro<TeamDetailFacts>({
    key: "team-detail.models",
    parent: "members.teams",
    version: 1,
    match: { path: PATH, tab: "models" },
    icon: Layers,
    title: "Models",
    summary: "Choose which AI models people can use, the one new chats start on and how much they can spend.",
    bannerText: "This team can't use any of your AI providers yet. Share one with the team to give its members those models.",
    highlights: [
      { title: "Your providers, shared.", text: "Share an AI provider with everyone or with a team. Keys stay on the server." },
      { title: "A default model.", text: "Pick the model new chats in the desktop app start on." },
      { title: "Spend limits.", text: "Set a daily, weekly or monthly amount for everyone or a team." },
    ],
    example: {
      Component: TeamModelsExample,
      alt: "Example: Engineering starts new chats on claude-sonnet-4-5, can use Anthropic through everyone and OpenAI through the team, and has used $64 of a $200 monthly limit.",
    },
    docsUrl: docsPage("ai-gateway/overview"),
    ctas: [
      { when: (ctx) => (ctx.facts.providers ?? 0) > 0 && ctx.can("canManageGatewayProviders"), label: "Share an AI provider", href: getAiGatewayProvidersRoute() },
      { when: (ctx) => (ctx.facts.providers ?? 0) > 0, label: "Share an AI provider", href: getAiGatewayProvidersRoute(), locked: { reason: permissionLockReason("gateway_providers.manage") } },
      { when: (ctx) => ctx.can("canManageGatewayProviders"), label: "Add your first AI provider", href: getNewAiGatewayProviderRoute() },
      { when: () => true, label: "Add your first AI provider", href: getNewAiGatewayProviderRoute(), locked: { reason: permissionLockReason("gateway_providers.manage") } },
    ],
    // Box when the organization has no models at all (no providers, OpenWork Models off);
    // banner when it has providers but none reaches this team.
    setupState: (ctx) => {
      if (ctx.facts.providers === undefined || ctx.facts.openworkModels === undefined) return "done";
      if (ctx.facts.openworkModels) return "done";
      if (ctx.facts.providers === 0) return "none";
      return ctx.facts.sharedProviders === 0 ? "partial" : "done";
    },
  }),

  defineFeatureIntro<TeamDetailFacts>({
    key: "team-detail.workbot",
    parent: "members.teams",
    version: 1,
    match: { path: PATH, tab: "workbot" },
    icon: MessageCircle,
    title: "Workbot",
    summary: "Choose which teams have Workbot, and give a team its own model and name, or keep Everyone's.",
    highlights: [
      { title: "On for the teams you choose.", text: "Turn Workbot off for Everyone and on for a pilot team, or off for one team." },
      { title: "A model and a name for the team.", text: "People in the team start new Workbot chats on its model and see the name you gave it." },
      { title: "Several teams at once.", text: "Someone in teams with different settings gets Everyone's." },
    ],
    example: {
      Component: TeamWorkbotExample,
      alt: "Example: Support calls Workbot Helpdesk and starts on Claude Sonnet 4.5, Sales uses Everyone's name, Workbot, and model, GPT-6 Luna, and Workbot is off for Engineering.",
    },
    docsUrl: docsPage("workbot/overview"),
    // The tab is the editor, and "From Everyone" is a valid state: `?` only.
    ctas: [],
    setupState: () => "done",
  }),

  defineFeatureIntro<TeamDetailFacts>({
    key: "team-detail.prompts",
    parent: "members.teams",
    version: 1,
    match: { path: PATH, tab: "prompts" },
    icon: ScrollText,
    title: "Prompts",
    summary: "Give agents standing instructions for everyone, or for one team.",
    highlights: [
      { title: "Followed by every agent.", text: "OpenWork adds the prompt to the instructions of every agent in people's desktop apps." },
      { title: "Everyone first, then teams.", text: "A team's prompt comes after the prompt for everyone, so it can add to it." },
      { title: "Picked up on the next sync.", text: "Changes reach people's apps the next time they sync." },
    ],
    example: {
      Component: TeamPromptExample,
      alt: "Example: a prompt for everyone about writing for customers and pricing, then Support's prompt about linking help articles and escalating refunds.",
    },
    docsUrl: docsPage("cloud/share-with-your-team/prompts"),
    ctas: [
      { when: (ctx) => ctx.facts.canEditPrompts === true, label: "Add a prompt", href: WRITE_PROMPT },
      { when: () => true, label: "Add a prompt", href: WRITE_PROMPT, locked: { reason: permissionLockReason("prompts.manage") } },
    ],
    // Box only when no prompt applies here at all.
    setupState: (ctx) => {
      if (ctx.facts.hasPrompt === undefined) return "done";
      return ctx.facts.hasPrompt ? "done" : "none";
    },
  }),

  defineFeatureIntro<TeamDetailFacts>({
    key: "team-detail.desktop",
    parent: "members.teams",
    version: 1,
    match: { path: PATH, tab: "desktop" },
    icon: Laptop,
    title: "Prompt suggestions",
    summary: "Show your own suggested tasks when people start a new session in the desktop app.",
    highlights: [
      { title: "Two or three cards.", text: "Each has a short title and the prompt it puts in the message box." },
      { title: "For everyone or a team.", text: "A team can keep Everyone's suggestions or have its own." },
      { title: "Enterprise plan.", text: "Changing suggestions is part of the Enterprise plan." },
    ],
    example: {
      Component: PromptCardsExample,
      alt: "Example: three suggestion cards in a new desktop session: summarize this week's tickets, draft a renewal email and prepare a call brief.",
    },
    docsUrl: docsPage("cloud/share-with-your-team/team-prompt-cards"),
    // The tab shows the built-in suggestions until changed: `?` only.
    ctas: [],
    setupState: () => "done",
  }),
];
