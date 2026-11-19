import { FileText, GitFork, Github, Puzzle, Server, Terminal, Users, Webhook } from "lucide-react";
import {
  getImportPluginRoute,
  getNewPluginRoute,
  getPluginSourcesRoute,
  getPluginsRoute,
  permissionLockReason,
} from "../../../../_lib/den-org";
import { defineFeatureIntro, type FeatureIntroContext, type FeatureIntroCta } from "../types";
import { docsPage } from "./docs";
import { PluginAccessExample } from "./examples/plugins/access-example";
import { PluginAgentsExample, PluginCommandsExample, PluginHooksExample, PluginMcpsExample } from "./examples/plugins/parts-example";
import { PluginsExample } from "./examples/plugins/plugins-example";
import { PluginCreateExample, PluginImportExample, PluginSkillExample } from "./examples/plugins/setup-example";
import { PluginSourcesExample } from "./examples/plugins/sources-example";

/**
 * Facts the Plugins pages report from data they already load
 * (`GET /v1/plugins`, `GET /v1/connector-accounts?connectorType=github`,
 * a plugin's access grants). A missing fact means "not loaded yet": a section
 * never takes over the page on a guess.
 */
export type PluginsFacts = {
  /** Active plugins the viewer can see. */
  plugins?: number;
  /** Who made them, when that was one other person (`createdByOrgMembershipId`). */
  setUpBy?: string | null;
  /** Agents, commands, hooks and MCPs across those plugins (Plugin Directory tabs). */
  agents?: number;
  commands?: number;
  hooks?: number;
  mcps?: number;
  /** Connected GitHub accounts (Sources). */
  githubSources?: number;
  /** Plugin page: shared with everyone, a team or anyone besides its owner, directly or through a collection. Null: unknown. */
  sharedBeyondOwner?: boolean | null;
  /** Plugin page: the viewer may change who can use it (owner, plugin manager or `sharing.manage_all`). */
  canEditAccess?: boolean;
};

type Ctx = FeatureIntroContext<PluginsFacts>;

const PATH = getPluginsRoute();
const IMPORT_LOCK = permissionLockReason("plugins.import");
const SOURCES_LOCK = permissionLockReason("connectors.manage");
const DOCS_PLUGINS = "cloud/share-with-your-team/plugins";
const DOCS_PARTS = "cloud/share-with-your-team/plugin-agents-commands-hooks";
const DOCS_SOURCES = "cloud/share-with-your-team/github-sources";
const DOCS_PUBLISH = "start-here/do-work-with-it/publish-and-copy-a-skill";

function pluginsSetUp(ctx: Ctx): boolean {
  return (ctx.facts.plugins ?? 0) > 0;
}

/** A tab with nothing in it while plugins exist shows its box; unknown shows nothing. */
function tabState(count: number | undefined) {
  return count === undefined || count > 0 ? "done" : "none";
}

/** Agents and hooks only arrive with Claude-compatible plugins synced from a GitHub repository. */
const githubSourceCtas: readonly FeatureIntroCta<PluginsFacts>[] = [
  // Sources lists each connected account with its repositories and where to add another.
  { when: (ctx) => ctx.can("canManageSyncSources") && (ctx.facts.githubSources ?? 0) > 0, label: "Add a repository", href: getPluginSourcesRoute() },
  { when: (ctx) => ctx.can("canManageSyncSources"), label: "Connect GitHub", href: getPluginSourcesRoute() },
  { when: () => true, label: "Connect GitHub", href: getPluginSourcesRoute(), locked: { reason: SOURCES_LOCK } },
];

const createPluginCtas: readonly FeatureIntroCta<PluginsFacts>[] = [
  // Any member can create a plugin (`plugin.create` needs no permission), so there is no locked variant.
  { when: () => true, label: "Create a plugin", href: getNewPluginRoute() },
];

export const pluginsIntros = [
  defineFeatureIntro<PluginsFacts>({
    key: "plugins",
    version: 1,
    match: { path: PATH },
    icon: Puzzle,
    title: "Plugins",
    summary: "Give your team's AI the same playbooks, so everyone's work gets done your way.",
    highlights: [
      { title: "Skills, commands and connectors.", text: "Bundle the steps for one kind of work with the apps it needs." },
      { title: "Start from GitHub.", text: "Import a public plugin, or connect a repository so changes come in on their own." },
      { title: "You choose who.", text: "Everyone, some teams or a few people. Nobody else gets it until you share it." },
      { title: "Ready in their OpenWork.", text: "It shows up in their Library, and the AI uses a skill when a request matches it." },
    ],
    example: {
      Component: PluginsExample,
      alt: "Example: Sales playbook from GitHub for Sales, Release notes for everyone and Brand voice for Marketing, then Sam Lee asking for release notes and the AI using the Release notes skill.",
    },
    docsUrl: docsPage(DOCS_PLUGINS),
    ctas: [
      { when: (ctx) => !pluginsSetUp(ctx), label: "Create your first plugin", href: getNewPluginRoute() },
      { when: (ctx) => pluginsSetUp(ctx), label: "See your plugins", href: PATH, note: (ctx) => (ctx.facts.setUpBy ? `Set up by ${ctx.facts.setUpBy}` : null) },
      ...createPluginCtas,
    ],
    // Full screen only once the list has loaded and is empty.
    setupState: (ctx) => {
      if (ctx.facts.plugins === undefined) return "done";
      return pluginsSetUp(ctx) ? "done" : "none";
    },
  }),

  defineFeatureIntro<PluginsFacts>({
    key: "plugins.agents",
    parent: "plugins",
    version: 1,
    match: { path: PATH, tab: "agents", tabParam: "view" },
    icon: Users,
    title: "Agents",
    summary: "Helpers that come with a plugin, each set up for one kind of task.",
    highlights: [
      { title: "From GitHub.", text: "Claude-compatible plugins in a connected repository can include agents." },
      { title: "All in one list.", text: "Every agent across your plugins, with the plugin it came with." },
      { title: "Shared with the plugin.", text: "Whoever can use the plugin gets its agents too." },
    ],
    example: { Component: PluginAgentsExample, alt: "Example: Deal reviewer from Sales playbook, Changelog writer from Release notes and Copy editor from Brand voice." },
    docsUrl: docsPage(`${DOCS_PARTS}#agents`),
    ctas: githubSourceCtas,
    setupState: (ctx) => tabState(ctx.facts.agents),
  }),

  defineFeatureIntro<PluginsFacts>({
    key: "plugins.commands",
    parent: "plugins",
    version: 1,
    match: { path: PATH, tab: "commands", tabParam: "view" },
    icon: Terminal,
    title: "Commands",
    summary: "Shortcuts like /follow-up that run a set task the same way every time.",
    highlights: [
      { title: "Write one in a plugin.", text: "Name it and say what should happen when someone runs it." },
      { title: "Or bring them in.", text: "Commands in a connected GitHub repository come in with their plugin." },
      { title: "All in one list.", text: "Every command across your plugins, with the plugin it came with." },
    ],
    example: { Component: PluginCommandsExample, alt: "Example: /deal-summary, /release-notes and /brand-check, each from its plugin." },
    docsUrl: docsPage(`${DOCS_PARTS}#commands`),
    ctas: createPluginCtas,
    setupState: (ctx) => tabState(ctx.facts.commands),
  }),

  defineFeatureIntro<PluginsFacts>({
    key: "plugins.hooks",
    parent: "plugins",
    version: 1,
    match: { path: PATH, tab: "hooks", tabParam: "view" },
    icon: Webhook,
    title: "Hooks",
    summary: "Steps that run on their own at set moments, like when a session starts or before a tool is used.",
    highlights: [
      { title: "From GitHub.", text: "Claude-compatible plugins in a connected repository can include hooks." },
      { title: "See when each runs.", text: "Every hook across your plugins, the moment it runs and the plugin it came with." },
    ],
    example: { Component: PluginHooksExample, alt: "Example: load the brand guide when a session starts, check before sending email, and save a summary when a session ends." },
    docsUrl: docsPage(`${DOCS_PARTS}#hooks`),
    ctas: githubSourceCtas,
    setupState: (ctx) => tabState(ctx.facts.hooks),
  }),

  defineFeatureIntro<PluginsFacts>({
    key: "plugins.mcps",
    parent: "plugins",
    version: 1,
    match: { path: PATH, tab: "mcps", tabParam: "view" },
    icon: Server,
    title: "MCPs",
    summary: "Put the apps a plugin needs inside it, so its skills can work in them straight away.",
    highlights: [
      { title: "Use your connectors.", text: "Add one you already set up in Connectors when you create a plugin." },
      { title: "Or bring them in.", text: "Remote MCP servers in a GitHub plugin come in when you import it." },
      { title: "All in one list.", text: "Every app across your plugins, with the plugin it came with." },
    ],
    example: { Component: PluginMcpsExample, alt: "Example: HubSpot in Sales playbook, Linear in Release notes and Notion in Brand voice, with how many things the AI can do in each." },
    docsUrl: docsPage("cloud/share-with-your-team/connectors"),
    ctas: createPluginCtas,
    setupState: (ctx) => tabState(ctx.facts.mcps),
  }),

  defineFeatureIntro<PluginsFacts>({
    key: "plugins.sources",
    // No parent: Sources is where an empty organization connects GitHub, so it never gives way to the section intro.
    version: 1,
    match: { path: PATH, tab: "sources", tabParam: "view" },
    icon: GitFork,
    title: "Sources",
    summary: "Keep plugins in step with the GitHub repositories your team already maintains.",
    highlights: [
      { title: "Connect once.", text: "Install the OpenWork GitHub app and choose the repositories it can read." },
      { title: "Stays up to date.", text: "When a connected repository changes, its plugins update on their own." },
      { title: "Or import once.", text: "Paste a public plugin's GitHub link to copy its skills and MCP servers in." },
    ],
    example: { Component: PluginSourcesExample, alt: "Example: the @acme GitHub account with two repositories bringing in three plugins, and Sales playbook updating after a new version on main." },
    docsUrl: docsPage(DOCS_SOURCES),
    ctas: [
      { when: (ctx) => ctx.can("canImportPlugins"), label: "Import from GitHub", href: getImportPluginRoute() },
      { when: () => true, label: "Import from GitHub", href: getImportPluginRoute(), locked: { reason: IMPORT_LOCK } },
    ],
    setupState: (ctx) => {
      if (ctx.facts.githubSources === undefined) return "done";
      return ctx.facts.githubSources > 0 ? "done" : "none";
    },
  }),

  defineFeatureIntro<PluginsFacts>({
    key: "plugins.access",
    parent: "plugins",
    version: 1,
    match: { path: `${PATH}/:pluginId` },
    icon: Users,
    title: "Who can use it",
    summary: "Give a plugin to the people who need it, with nothing for them to install.",
    bannerText: "No one else can use this plugin yet. Share it with everyone, a team or a few people, and it shows up in their Library.",
    highlights: [
      { title: "Everyone or a few.", text: "Turn on everyone in the organization, or add teams and people." },
      { title: "Changes save right away.", text: "Undo is there if you change your mind." },
      { title: "In their Library.", text: "Teammates find it in OpenWork, and the AI picks it up when a request matches." },
    ],
    example: { Component: PluginAccessExample, alt: "Example: Sales playbook shared with Sales, Customer Success and Sam Lee." },
    docsUrl: docsPage(`${DOCS_PLUGINS}#choose-who-can-use-it`),
    ctas: [
      { when: (ctx) => ctx.facts.canEditAccess === true, label: "Choose who can use it", href: "#who-can-use-it" },
      { when: () => true, label: "Choose who can use it", href: "#who-can-use-it", locked: { reason: permissionLockReason("sharing.manage_all") } },
    ],
    // Banner only: a plugin nobody but its owner can use yet. Unknown shows nothing.
    setupState: (ctx) => (ctx.facts.sharedBeyondOwner === false ? "partial" : "done"),
  }),

  defineFeatureIntro<PluginsFacts>({
    key: "plugins.new",
    version: 1,
    // Never shown on its own: the form is the setup step. It answers `?` there.
    match: { path: getNewPluginRoute() },
    icon: Puzzle,
    title: "Create a plugin",
    summary: "Write down how your team does a piece of work once, and everyone's AI can do it that way.",
    highlights: [
      { title: "Skills.", text: "The steps in plain words, and when the AI should use them." },
      { title: "Commands.", text: "A shortcut like /follow-up that runs a set task." },
      { title: "Connectors.", text: "An app the skills need, from the connectors you already added." },
    ],
    example: { Component: PluginCreateExample, alt: "Example: Sales playbook with a skill to prep a sales call, a /follow-up command and HubSpot." },
    docsUrl: docsPage(`${DOCS_PLUGINS}#create-a-plugin`),
    ctas: createPluginCtas,
    setupState: () => "done",
  }),

  defineFeatureIntro<PluginsFacts>({
    key: "plugins.import",
    version: 1,
    // Never shown on its own: the import form is the setup step. It answers `?` there.
    match: { path: getImportPluginRoute() },
    icon: Github,
    title: "Import from GitHub",
    summary: "Start from a plugin someone already wrote, instead of from scratch.",
    highlights: [
      { title: "Public repositories.", text: "Paste the link to a Claude-compatible plugin or an Agent Plugin." },
      { title: "Pick what comes in.", text: "Choose its skills and MCP servers; anything that can't come in says why." },
      { title: "Then share it.", text: "Finish it like any plugin you make here, and choose who can use it." },
    ],
    example: { Component: PluginImportExample, alt: "Example: a public sales plugin with two skills and HubSpot ready to import, and a desktop-only server that can't be imported." },
    docsUrl: docsPage(`${DOCS_PLUGINS}#import-a-plugin-from-github`),
    ctas: [
      { when: (ctx) => ctx.can("canImportPlugins"), label: "Import from GitHub", href: getImportPluginRoute() },
      { when: () => true, label: "Import from GitHub", href: getImportPluginRoute(), locked: { reason: IMPORT_LOCK } },
    ],
    setupState: () => "done",
  }),

  defineFeatureIntro<PluginsFacts>({
    key: "plugins.skill",
    version: 1,
    // Never shown on its own: answers `?` on a plugin's new and edit skill forms (the edit form registers it).
    match: { path: `${PATH}/:pluginId/skills/new` },
    icon: FileText,
    title: "Skills",
    summary: "A skill teaches the AI one way of doing a task, and it uses it whenever a request matches.",
    highlights: [
      { title: "Name it.", text: "A short name in lowercase, like customer-research." },
      { title: "Say when.", text: "The description tells the AI when to use it." },
      { title: "Write the steps.", text: "Plain words or Markdown, as long as the task needs." },
    ],
    example: { Component: PluginSkillExample, alt: "Example: the prep-a-sales-call skill, used when someone has a customer call coming up, with three steps." },
    docsUrl: docsPage(`${DOCS_PUBLISH}#1-create-the-skill`),
    // The form on screen is the action; a link back to it would go nowhere.
    ctas: [],
    setupState: () => "done",
  }),
];
