import { KeyRound } from "lucide-react";
import { getApiKeysRoute, permissionLockReason } from "../../../../_lib/den-org";
import { defineFeatureIntro, type FeatureIntroContext } from "../types";
import { docsPage } from "./docs";
import { ApiKeysExample } from "./examples/settings/api-keys-example";

/**
 * Facts Settings › API Keys reports from data it already loads (`GET /v1/api-keys`).
 * A missing fact means "not loaded yet": the intro never takes over the page on a guess.
 */
export type ApiKeysFacts = {
  /** Keys in the organization, anyone's. */
  apiKeys?: number;
};

type Ctx = FeatureIntroContext<ApiKeysFacts>;

const PATH = getApiKeysRoute();
/** `?new=1` opens the Issue a new key form (DESIGN.md I5). */
export const API_KEYS_NEW_ROUTE = `${PATH}?new=1`;

export const apiKeysIntros = [
  defineFeatureIntro<ApiKeysFacts>({
    key: "api-keys",
    version: 1,
    match: { path: PATH },
    icon: KeyRound,
    title: "API Keys",
    summary: "Let your scripts and CI set up and run OpenWork without anyone signing in.",
    highlights: [
      { title: "Acts as you.", text: "A key works in this organization only, and can do what you can do here." },
      { title: "For scripts and CI.", text: "Send it in the x-api-key header to call the OpenWork API, for example to keep teams, providers and connectors in sync." },
      { title: "Shown once.", text: "Copy the key when you create it. OpenWork keeps only a hash." },
      { title: "Expires in 90 days.", text: "Delete any key at any time, and it stops working at once." },
    ],
    example: {
      Component: ApiKeysExample,
      alt: "Example: three keys, CI deploy and Team provisioning owned by Ada Lovelace and Usage export owned by Grace Hopper, with when each was last used, and a script calling the OpenWork API with the x-api-key header.",
    },
    docsUrl: docsPage("cloud/api-keys"),
    ctas: [
      { when: (ctx: Ctx) => ctx.can("canManageApiKeys"), label: "Create an API key", href: API_KEYS_NEW_ROUTE },
      { when: () => true, label: "Create an API key", href: API_KEYS_NEW_ROUTE, locked: { reason: permissionLockReason("api_keys.manage") } },
    ],
    // Full screen only once the list has loaded and is empty.
    setupState: (ctx) => {
      if (ctx.facts.apiKeys === undefined) return "done";
      return ctx.facts.apiKeys > 0 ? "done" : "none";
    },
  }),
];
