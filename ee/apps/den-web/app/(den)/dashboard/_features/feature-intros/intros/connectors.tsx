import { Plug, Plus, Users } from "lucide-react";
import { getAddConnectorRoute, getMcpConnectionsRoute, permissionLockReason } from "../../../../_lib/den-org";
import { defineFeatureIntro, type FeatureIntroContext } from "../types";
import { docsPage } from "./docs";
import { ConnectorAccessExample } from "./examples/connectors/access-example";
import { ConnectorAddExample } from "./examples/connectors/add-example";
import { ConnectorsExample } from "./examples/connectors/connectors-example";

/**
 * Facts the Connectors pages report from data they already load
 * (`GET /v1/mcp-connections`). A missing fact means "not loaded yet": a
 * section never takes over the page on a guess.
 */
export type ConnectorsFacts = {
  /** Connectors in the list, Google Workspace and Microsoft 365 included. */
  connectors?: number;
  /** Who added them, when that was one other person (`createdByName`). */
  setUpBy?: string | null;
  /** Connector page: shared with everyone, a team or anyone besides the viewer. */
  sharedBeyondYou?: boolean;
  /** Connector page: the viewer may change who can use it (`connections.manage`, or they added it). */
  canEditAccess?: boolean;
};

type Ctx = FeatureIntroContext<ConnectorsFacts>;

const PATH = getMcpConnectionsRoute();
const MANAGE_CONNECTIONS_LOCK = permissionLockReason("connections.manage");
const DOCS = "cloud/share-with-your-team/connectors";
/** The full step-by-step guide behind the overview. */
const DOCS_GUIDE = "cloud/share-with-your-team/shared-mcp-connections";

function connectorsSetUp(ctx: Ctx): boolean {
  return (ctx.facts.connectors ?? 0) > 0;
}

export const connectorsIntros = [
  defineFeatureIntro<ConnectorsFacts>({
    key: "connectors",
    version: 1,
    match: { path: PATH },
    icon: Plug,
    title: "Connectors",
    summary: "Let your team's AI read and act in the apps you already use.",
    highlights: [
      { title: "Add an app once.", text: "Google Workspace, Microsoft 365, Slack, Notion, Linear, GitHub and more, or any MCP by its address." },
      { title: "Their own account, or one for all.", text: "Each person signs in so the AI works with their permissions, or everyone shares one account." },
      { title: "You choose who.", text: "Everyone, some teams or a few people. It shows up in their Library, with nothing to install." },
      { title: "Wherever they work.", text: "In the OpenWork desktop app, and in Claude, Cursor or other MCP apps when you turn it on." },
    ],
    example: {
      Component: ConnectorsExample,
      alt: "Example: Google Workspace and Slack for everyone, Linear for Product, GitHub for Engineering, and what people's AI did with each today.",
    },
    docsUrl: docsPage(DOCS),
    ctas: [
      { when: (ctx) => ctx.can("canManageConnections") && !connectorsSetUp(ctx), label: "Add your first connector", href: getAddConnectorRoute() },
      {
        when: (ctx) => connectorsSetUp(ctx) && ctx.can("canViewAllConnections"),
        label: "See your connectors",
        href: PATH,
        note: (ctx) => (ctx.facts.setUpBy ? `Set up by ${ctx.facts.setUpBy}` : null),
      },
      { when: (ctx) => ctx.can("canManageConnections"), label: "Add a connector", href: getAddConnectorRoute() },
      { when: () => true, label: "Add your first connector", href: getAddConnectorRoute(), locked: { reason: MANAGE_CONNECTIONS_LOCK } },
    ],
    // Full screen only once the list has loaded and is empty.
    setupState: (ctx) => {
      if (ctx.facts.connectors === undefined) return "done";
      return connectorsSetUp(ctx) ? "done" : "none";
    },
  }),

  defineFeatureIntro<ConnectorsFacts>({
    key: "connectors.add",
    version: 1,
    // Never shown on its own: the add flow is the setup step. It answers `?` on the catalog and setup forms.
    match: { path: getAddConnectorRoute() },
    icon: Plus,
    title: "Add a connector",
    summary: "Connect an app once, and the people you choose can use it from their AI.",
    highlights: [
      { title: "Ready-made apps.", text: "Google Workspace, Microsoft 365, GitHub, Notion, Linear, Slack, Stripe and more." },
      { title: "Any MCP.", text: "Paste an address to connect an app that isn't in the list." },
      { title: "Checked first.", text: "OpenWork makes sure it can reach the app, sign in and see what the AI can do before anyone uses it." },
    ],
    example: {
      Component: ConnectorAddExample,
      alt: "Example: adding Linear, with its four checks done: finds Linear, knows how you sign in, signed in, and 24 things the AI can do.",
    },
    docsUrl: docsPage(`${DOCS_GUIDE}#add-a-connector`),
    ctas: [
      { when: (ctx) => ctx.can("canManageConnections"), label: "Add a connector", href: getAddConnectorRoute() },
      { when: () => true, label: "Add a connector", href: getAddConnectorRoute(), locked: { reason: MANAGE_CONNECTIONS_LOCK } },
    ],
    setupState: () => "done",
  }),

  defineFeatureIntro<ConnectorsFacts>({
    key: "connectors.access",
    parent: "connectors",
    version: 1,
    match: { path: `${PATH}/:connectorId` },
    icon: Users,
    title: "Who can use it",
    summary: "Give a connector to the people who need it, with nothing for them to set up.",
    bannerText: "No one else can use this connector yet. Share it with everyone, a team or a few people, and it shows up in their Library.",
    highlights: [
      { title: "Everyone or a few.", text: "Turn on everyone in the organization, or add teams and people." },
      { title: "Signs in as them.", text: "When each person signs in, the AI works with their own permissions." },
      { title: "Changes apply right away.", text: "Adding or removing someone takes effect on every device." },
    ],
    example: {
      Component: ConnectorAccessExample,
      alt: "Example: Linear shared with Engineering, Product and Sam Lee, each signing in with their own account, and three of the 24 things their AI can do.",
    },
    docsUrl: docsPage(`${DOCS}#who-can-use-it`),
    ctas: [
      { when: (ctx) => ctx.facts.canEditAccess === true || ctx.can("canManageConnections"), label: "Choose who can use it", href: "#who-can-use-it" },
      { when: () => true, label: "Choose who can use it", href: "#who-can-use-it", locked: { reason: MANAGE_CONNECTIONS_LOCK } },
    ],
    // Banner only: a connector nobody but the viewer can use yet. Unknown shows nothing.
    setupState: (ctx) => (ctx.facts.sharedBeyondYou === false ? "partial" : "done"),
  }),
];
