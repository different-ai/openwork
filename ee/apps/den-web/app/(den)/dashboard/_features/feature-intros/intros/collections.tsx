import { Package, Store } from "lucide-react";
import { getMarketplacesRoute, permissionLockReason } from "../../../../_lib/den-org";
import { defineFeatureIntro, type FeatureIntroContext } from "../types";
import { docsPage } from "./docs";
import { CollectionPluginsExample, CollectionsExample } from "./examples/settings/collections-example";

/**
 * Facts Settings › Advanced › Collections reports from data it already loads
 * (`GET /v1/marketplaces`, a collection's plugins). A missing fact means "not loaded yet".
 */
export type CollectionsFacts = {
  /** Active collections, the built-in OpenWork Marketplace included. Null: unknown (a collection's page). */
  collections?: number | null;
  /** The organization's own collections, without the built-in one every organization gets. */
  ownCollections?: number | null;
  /** Collection page: plugins in this collection. */
  collectionPlugins?: number;
  /** Collection page: the viewer can add plugins (`sharing.manage_all`). */
  canAddPlugins?: boolean;
};

type Ctx = FeatureIntroContext<CollectionsFacts>;

const PATH = getMarketplacesRoute();
const DOCS = "cloud/share-with-your-team/collections";
/** `?new=1` opens the New collection form (DESIGN.md I5). */
export const COLLECTIONS_NEW_ROUTE = `${PATH}?new=1`;
/** On a collection's page, `?addPlugin=1` opens Add a plugin with this collection chosen. */
export const COLLECTION_ADD_PLUGIN_PARAM = "addPlugin";

export const collectionsIntros = [
  defineFeatureIntro<CollectionsFacts>({
    key: "collections",
    version: 1,
    match: { path: PATH },
    icon: Store,
    title: "Collections",
    summary: "Give a team a whole set of plugins in one step, and change who gets them in one place.",
    bannerText: "Group the plugins one team needs into a collection, so one access change covers the whole set.",
    highlights: [
      { title: "One audience for many plugins.", text: "Everyone, some teams or a few people get every plugin in the collection." },
      { title: "Grows with you.", text: "Add plugins over time; people with access get them in the desktop app." },
      { title: "Optional.", text: "To share a single plugin, choose who can use it on its own page instead." },
      { title: "Built in.", text: "Every organization has the OpenWork Marketplace with OpenWork's own plugins." },
    ],
    example: {
      Component: CollectionsExample,
      alt: "Example: the built-in OpenWork Marketplace for everyone, Sales enablement with 4 plugins for Sales, and Engineering tools with 6 plugins for Engineering and Platform.",
    },
    docsUrl: docsPage(DOCS),
    ctas: [
      { when: (ctx: Ctx) => ctx.can("canManageMarketplaces"), label: "Create a collection", href: COLLECTIONS_NEW_ROUTE },
      { when: () => true, label: "Create a collection", href: COLLECTIONS_NEW_ROUTE, locked: { reason: permissionLockReason("marketplaces.manage") } },
    ],
    // Full screen with no collection at all, banner while only the built-in one exists.
    setupState: (ctx) => {
      if (ctx.facts.collections == null || ctx.facts.ownCollections == null) return "done";
      if (ctx.facts.collections === 0) return "none";
      return ctx.facts.ownCollections === 0 ? "partial" : "done";
    },
  }),

  defineFeatureIntro<CollectionsFacts>({
    key: "collections.plugins",
    parent: "collections",
    version: 1,
    match: { path: `${PATH}/:marketplaceId` },
    icon: Package,
    // The page already says "Plugins in this collection" right above the box.
    title: "Fill this collection",
    summary: "Put the plugins one audience needs together, and they get every one in the desktop app.",
    highlights: [
      { title: "Skills, commands and connectors.", text: "Build a plugin here, or import one from GitHub." },
      { title: "From a repository.", text: "Plugins from a connected source arrive on their own." },
      { title: "One audience.", text: "Choose who gets them on the Members tab." },
    ],
    example: {
      Component: CollectionPluginsExample,
      alt: "Example: Sales enablement with Account research, Proposal writer and Deal updates, all given to Sales.",
    },
    docsUrl: docsPage(`${DOCS}#add-plugins`),
    ctas: [
      { when: (ctx: Ctx) => ctx.facts.canAddPlugins === true, label: "Add a plugin", href: `?${COLLECTION_ADD_PLUGIN_PARAM}=1` },
      { when: () => true, label: "Add a plugin", href: `?${COLLECTION_ADD_PLUGIN_PARAM}=1`, locked: { reason: permissionLockReason("sharing.manage_all") } },
    ],
    // Box in place of "No plugins in this collection yet".
    setupState: (ctx) => {
      if (ctx.facts.collectionPlugins === undefined) return "done";
      return ctx.facts.collectionPlugins > 0 ? "done" : "none";
    },
  }),
];
