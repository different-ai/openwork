import { FileText, KeyRound, LibraryBig, Package, Plug, Plus, Server, Users } from "lucide-react";
import {
  getAddConnectorRoute,
  getLibraryAddConnectorRoute,
  getLibraryNewPluginRoute,
  getLibraryRoute,
  getNewAiGatewayProviderRoute,
} from "../../../../_lib/den-org";
import { defineFeatureIntro, type FeatureIntroContext, type FeatureIntroCta, type FeatureIntroKey } from "../types";
import { docsPage } from "./docs";
import { LibraryExample } from "./examples/library/library-example";
import { LibraryShareExample } from "./examples/library/share-example";
import {
  LibraryConnectorsExample,
  LibraryModelKeyExample,
  LibraryModelsExample,
  LibraryPluginsExample,
  LibrarySkillsExample,
} from "./examples/library/tab-examples";

/**
 * Facts My Library reports from data it already loads (`GET /v1/me/library`,
 * `GET /v1/inference-providers?scope=usable` and the viewer's own model keys
 * from `GET /v1/llm-providers`). Counts are what the viewer can use: shared
 * with them or made by them. A missing fact means "not loaded yet": the page
 * never gives way to an intro on a guess.
 */
export type LibraryFacts = {
  /** Everything in the Library, models and workflows included. */
  items?: number;
  connectors?: number;
  /** Plugins made of one skill, which the Library lists as skills. */
  skills?: number;
  plugins?: number;
  /** Models from the organization plus the viewer's own keys. */
  models?: number;
};

/** The Library's `?show=` tabs and their intros. "All" is the section itself. */
export type LibraryTab = "connectors" | "skills" | "plugins" | "models";

export const LIBRARY_TAB_INTROS: Record<LibraryTab, FeatureIntroKey> = {
  connectors: "library.connectors",
  skills: "library.skills",
  plugins: "library.plugins",
  models: "library.models",
};

type Ctx = FeatureIntroContext<LibraryFacts>;
type Cta = FeatureIntroCta<LibraryFacts>;

const PATH = getLibraryRoute();
const ADD_KEY_ROUTE = `${PATH}/model-providers/new`;
const PRIVATE_NOTE = "Only you can use it until you share it.";

/*
 * Docs: My Library has its own pages (overview, models and keys, sharing);
 * "Connect your services" covers the Library's connectors from a member's side.
 */
const DOCS_LIBRARY = "my-library/overview";
const DOCS_MODELS = "my-library/models-and-keys";
const DOCS_CONNECT = "start-here/connect-your-stack/connect-services";
const DOCS_SKILLS = "start-here/do-work-with-it/publish-and-copy-a-skill";
const DOCS_PLUGINS = "start-here/do-work-with-it/skills-plugins-and-mcp";
const DOCS_SHARE = "my-library/share";

/** A tab with nothing of its kind while the Library has other things shows its box; unknown shows nothing. */
function tabState(count: number | undefined) {
  return count === undefined || count > 0 ? "done" : "none";
}

/*
 * Any member can add a connector for themselves (an app where each person
 * signs in, or one with no sign-in) and create skills and plugins, so these
 * have no locked variant. Someone who manages connections can add one for the
 * whole team from Manage instead.
 */
const addConnectorCtas: readonly Cta[] = [
  { when: (ctx) => ctx.can("canManageConnections"), label: "Add a connector for your team", href: getAddConnectorRoute() },
  { when: () => true, label: "Add a connector", href: getLibraryAddConnectorRoute(), note: () => PRIVATE_NOTE },
];

function librarySetUp(ctx: Ctx): boolean {
  return (ctx.facts.items ?? 0) > 0;
}

export const libraryIntros = [
  defineFeatureIntro<LibraryFacts>({
    key: "library",
    version: 1,
    match: { path: PATH },
    icon: LibraryBig,
    title: "My Library",
    summary: "Everything your team shares with you, and what you make yourself, in one place.",
    highlights: [
      { title: "Shared with you.", text: "Connectors, skills, plugins and models your team gives you show up here on their own." },
      { title: "Your own account.", text: "Sign in to a connector once, and your AI works in it with your permissions." },
      { title: "Make your own.", text: "Add a connector or write a skill. Only you can use it until you share it." },
      { title: "Ready in OpenWork.", text: "Everything here is in the OpenWork app too, under Settings › Library." },
    ],
    example: {
      Component: LibraryExample,
      alt: "Example: Linear from Product waiting for your sign-in, then Google Workspace, Slack, the Release notes skill and Claude Sonnet 5 from everyone, the Sales playbook plugin from Sales, and your own Weekly report skill.",
    },
    docsUrl: docsPage(DOCS_LIBRARY),
    ctas: addConnectorCtas,
    // Full screen only once everything has loaded and the viewer has nothing at all.
    setupState: (ctx) => {
      if (ctx.facts.items === undefined) return "done";
      return librarySetUp(ctx) ? "done" : "none";
    },
  }),

  defineFeatureIntro<LibraryFacts>({
    key: "library.connectors",
    parent: "library",
    version: 1,
    match: { path: PATH, tab: "connectors", tabParam: "show" },
    icon: Plug,
    title: "Connectors",
    summary: "Let your AI read and act in the apps you use, with your own account.",
    highlights: [
      { title: "From your team.", text: "Connectors shared with you show up here. Sign in once to start using one." },
      { title: "Or add your own.", text: "Slack, Notion, Linear and more, or any MCP by its address." },
      { title: "Private until you share.", text: "Give it to a teammate or a team when it's ready." },
    ],
    example: {
      Component: LibraryConnectorsExample,
      alt: "Example: Google Workspace and Slack from everyone, signed in; Linear from Product, waiting for your sign-in; and Notion, which you added.",
    },
    docsUrl: docsPage(DOCS_CONNECT),
    ctas: addConnectorCtas,
    setupState: (ctx) => tabState(ctx.facts.connectors),
  }),

  defineFeatureIntro<LibraryFacts>({
    key: "library.skills",
    parent: "library",
    version: 1,
    match: { path: PATH, tab: "skills", tabParam: "show" },
    icon: FileText,
    title: "Skills",
    summary: "Teach the AI how you do a task once, in plain words, and it does it that way every time.",
    highlights: [
      { title: "From your team.", text: "Skills shared with you are ready to use. The AI picks one when a request matches." },
      { title: "Write your own.", text: "Name it, say when to use it, and write the steps." },
      { title: "Share it when it works.", text: "Give it to a teammate or a team." },
    ],
    example: {
      Component: LibrarySkillsExample,
      alt: "Example: Release notes from everyone, Brand voice from Marketing, and your own Weekly report skill.",
    },
    docsUrl: docsPage(`${DOCS_SKILLS}#1-create-the-skill`),
    ctas: [{ when: () => true, label: "Create a skill", href: getLibraryNewPluginRoute(null, "skill"), note: () => PRIVATE_NOTE }],
    setupState: (ctx) => tabState(ctx.facts.skills),
  }),

  defineFeatureIntro<LibraryFacts>({
    key: "library.plugins",
    parent: "library",
    version: 1,
    match: { path: PATH, tab: "plugins", tabParam: "show" },
    icon: Package,
    title: "Plugins",
    summary: "A whole way of working in one go: skills, commands and the apps they need.",
    highlights: [
      { title: "From your team.", text: "Plugins shared with you arrive with everything inside, with nothing to install." },
      { title: "Make one.", text: "Put your skills together with the connectors they need." },
      { title: "Share it.", text: "Give it to a teammate or a team, and they get all of it." },
    ],
    example: {
      Component: LibraryPluginsExample,
      alt: "Example: Sales playbook with three skills and HubSpot from Sales, and Customer research with two skills and Notion from everyone.",
    },
    docsUrl: docsPage(DOCS_PLUGINS),
    ctas: [{ when: () => true, label: "Create a plugin", href: getLibraryNewPluginRoute(), note: () => PRIVATE_NOTE }],
    setupState: (ctx) => tabState(ctx.facts.plugins),
  }),

  defineFeatureIntro<LibraryFacts>({
    key: "library.models",
    parent: "library",
    version: 1,
    match: { path: PATH, tab: "models", tabParam: "show" },
    icon: Server,
    title: "Models",
    summary: "The AI models you can use in OpenWork, from your team or with your own key.",
    highlights: [
      { title: "From your team.", text: "Models your organization gives you show up here, with nothing to set up." },
      { title: "Sign in if asked.", text: "Some providers need you to sign in with your own account first." },
      { title: "Bring your own key.", text: "Add a key from Anthropic, OpenAI or another provider. Only you can use it." },
    ],
    example: {
      Component: LibraryModelsExample,
      alt: "Example: Claude Sonnet 5 and GPT-6 Luna from everyone, Gemini 3 Pro waiting for your sign-in, and your own Anthropic key.",
    },
    docsUrl: docsPage(DOCS_MODELS),
    ctas: [
      { when: (ctx) => ctx.can("canManageGatewayProviders"), label: "Add an AI provider for your team", href: getNewAiGatewayProviderRoute() },
      // Any member can add a provider key for themselves (`POST /v1/llm-providers` needs no permission).
      { when: () => true, label: "Add your own key", href: ADD_KEY_ROUTE, note: () => "Only you can use your key." },
    ],
    setupState: (ctx) => tabState(ctx.facts.models),
  }),

  defineFeatureIntro<LibraryFacts>({
    key: "library.connectors.add",
    version: 1,
    // Never shown on its own: the catalog and setup checks are the setup step. It answers `?` there.
    match: { path: getLibraryAddConnectorRoute() },
    icon: Plus,
    title: "Add a connector",
    summary: "Connect an app for yourself, and your AI can work in it with your account.",
    highlights: [
      { title: "Ready-made apps.", text: "Slack, Notion, Linear, GitHub and more." },
      { title: "Any MCP.", text: "Paste an address to connect an app that isn't in the list." },
      { title: "Yours until you share it.", text: "Share it with teammates or a team later. Only admins can share with everyone." },
    ],
    example: {
      Component: LibraryConnectorsExample,
      alt: "Example: Google Workspace and Slack from everyone, signed in; Linear from Product, waiting for your sign-in; and Notion, which you added.",
    },
    docsUrl: docsPage(DOCS_CONNECT),
    // The catalog on screen is the action; a link back to it would go nowhere.
    ctas: [],
    setupState: () => "done",
  }),

  defineFeatureIntro<LibraryFacts>({
    key: "library.plugins.new",
    version: 1,
    // Never shown on its own: the form is the setup step. It answers `?` there (`?start=skill` too).
    match: { path: getLibraryNewPluginRoute() },
    icon: FileText,
    title: "Create a skill or plugin",
    summary: "Write down how you do a piece of work once, and your AI does it that way.",
    highlights: [
      { title: "A skill.", text: "The steps in plain words, and when the AI should use them." },
      { title: "A plugin.", text: "Several skills, with commands and the connectors they need." },
      { title: "Yours first.", text: "Only you can use it until you share it." },
    ],
    example: {
      Component: LibrarySkillsExample,
      alt: "Example: Release notes from everyone, Brand voice from Marketing, and your own Weekly report skill.",
    },
    docsUrl: docsPage(`${DOCS_SKILLS}#1-create-the-skill`),
    ctas: [],
    setupState: () => "done",
  }),

  defineFeatureIntro<LibraryFacts>({
    key: "library.models.key",
    version: 1,
    // Never shown on its own: the form is the setup step. It answers `?` there and on the edit form.
    match: { path: ADD_KEY_ROUTE },
    icon: KeyRound,
    title: "Use your own key",
    summary: "Add a key for an AI provider, and its models show up in your OpenWork.",
    highlights: [
      { title: "Only you.", text: "Nobody else can use your key." },
      { title: "Most providers.", text: "Anthropic, OpenAI, Google and others, or your own setup." },
      { title: "Change it any time.", text: "Edit or remove the key from its page." },
    ],
    example: {
      Component: LibraryModelKeyExample,
      alt: "Example: your Anthropic key, used by you only, giving you Claude Sonnet 5 and Claude Haiku 5.",
    },
    docsUrl: docsPage(`${DOCS_MODELS}#add-your-own-key`),
    ctas: [],
    setupState: () => "done",
  }),

  defineFeatureIntro<LibraryFacts>({
    key: "library.share",
    version: 1,
    // Never shown on its own: the share form is the action. Matches connectors; the plugin share page registers it.
    match: { path: `${PATH}/connectors/:connectionId/share` },
    icon: Users,
    title: "Share with your team",
    summary: "Give something you made to the teammates who need it, with nothing for them to set up.",
    highlights: [
      { title: "People or teams.", text: "Add teammates or whole teams, and it shows up in their Library." },
      { title: "The whole organization.", text: "Only admins can share with everyone." },
      { title: "Change it any time.", text: "Remove someone and they can no longer use it." },
    ],
    example: {
      Component: LibraryShareExample,
      alt: "Example: your Weekly report skill shared with the Product team and Sam Lee.",
    },
    docsUrl: docsPage(DOCS_SHARE),
    ctas: [],
    setupState: () => "done",
  }),
];
