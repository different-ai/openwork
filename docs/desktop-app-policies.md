# Desktop App Policies

Desktop app policy config is loaded from OpenWork Cloud through `GET /v1/me/desktop-config` and exposed inside the desktop app through `DesktopConfigProvider`.

App code should read policy state through the hooks in `apps/app/src/react-app/domains/cloud/desktop-config-provider.tsx`. Do not read the provider's internal refs directly; those are only used to compare and apply newly loaded config safely.

## Policy Keys

The canonical policy catalog lives in `packages/types/src/den/desktop-policies.ts` as `desktopPolicyDefinitions`. Add or change policy items there first so the API, Den web, and desktop app share the same IDs and copy.

Do not duplicate the list of policy IDs in app docs or feature code unless a feature is intentionally checking a specific policy. Import from the shared package when you need the full catalog.

`allowedDesktopVersions` is part of the desktop config response but is not a boolean policy item in `desktopPolicyDefinitions`.

`execution.browserOrigins` is the canonical approved-site list. `desktopExecutionPolicySchema` validates exact HTTP(S) origins, and `resolveDesktopExecutionPolicy()` intersects matching lists; omission adds no restriction and `[]` denies every site. Enforcement is server-owned in `apps/server/src/managed-desktop-policy.ts` and `managed-policy-rules.ts`, called by the native request guard in `apps/desktop/electron/browser-panel.mjs`, not a renderer-pushed host list. See [Approved websites](../packages/docs/cloud/share-with-your-team/desktop-policies.mdx#approved-websites) for configuration and scope.

For boolean policy keys, `false` means the feature is restricted or disabled. `true` or `undefined` means the app should not block the feature locally.

## Organization Prompt Suggestions

Desktop policy documents can also include `onboardingPrompts` and `onboardingPromptDescriptions`. The shared schema requires 2 or 3 prompts, caps each prompt at 500 characters, and caps each description at 120 characters.

In the desktop app, `onboardingPromptDescriptions` become prompt-card titles. `onboardingPrompts` become the visible card descriptions and the text inserted into the composer when a user clicks a card; the click does not auto-send.

Boolean policy keys are OR-unioned across matching policies by `calculateEffectiveDesktopPolicy()`. Prompt suggestions are different: `selectEffectiveOnboardingPromptConfig()` picks one matching prompt config by highest `priority`, then earliest `createdAt`, then policy `id`, falling back to the default policy only when no targeted prompt config applies.

## Organization system prompts

System prompts are available to every organization, independently of desktop policy prompt suggestions. People with `prompts.view` can open the Prompts tab for Everyone or a team; `prompts.manage` is required to save or remove prompts. Ordinary members cannot read the organization's prompt settings, but `GET /v1/me/prompts` returns the prompts assigned to them in their active organization.

Desktops append those prompts to agent instructions on provider sync: Everyone first, then teams by name, then directly assigned member prompts. Saving a revision or removing a prompt takes effect on the next sync. Stored prompt text remains encrypted at rest. There is no feature rollout switch for prompts.

## Organization Automation settings

Every organization has Automation settings under Settings. Any member can read `GET /v1/org/automation-settings`; changing them requires `organization.update`. Desktop and Cloud Automations default to allowed, but each also follows the deployment's Automation switches. Cloud Automations additionally require a configured headless runner; trying to enable Cloud without one returns `409 headless_runner_required`.

Turning either kind off prevents new Automations of that kind and skips scheduled runs, while keeping saved Automations and history. The desktop config reports the effective availability in `desktopAutomationsEnabled` and `cloudAutomationsEnabled`; the organization settings always apply, without a rollout override.

## Preferred Check

Use `useCheckDesktopRestriction()` when gating app behavior.

```tsx
import { useCheckDesktopRestriction } from "../domains/cloud/desktop-config-provider";

function Example() {
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const zenModelsRestricted = checkDesktopRestriction({
    restriction: "allowZenModel",
  });

  return zenModelsRestricted ? null : <ZenModelPicker />;
}
```

`checkDesktopRestriction()` returns `true` when the feature is restricted.

## Single Policy Hook

Use `useDesktopRestriction()` when a component only needs one policy value.

```tsx
import { useDesktopRestriction } from "../domains/cloud/desktop-config-provider";

function AddWorkspaceButton() {
  const multipleWorkspacesRestricted = useDesktopRestriction(
    "allowMultipleWorkspaces",
  );

  return (
    <button disabled={multipleWorkspacesRestricted}>
      Add workspace
    </button>
  );
}
```

## Raw Config

Use `useDesktopConfig()` when you need the raw config, loading state, or manual refresh function.

```tsx
import { useDesktopConfig } from "../domains/cloud/desktop-config-provider";

function DesktopPolicyDebug() {
  const desktopConfig = useDesktopConfig();

  return (
    <pre>
      {JSON.stringify({
        loading: desktopConfig.loading,
        config: desktopConfig.config,
      }, null, 2)}
    </pre>
  );
}
```

Use `useOrgRestrictions()` only when you need the raw config object without `loading`, `refresh`, or `checkRestriction`.

```tsx
import { useOrgRestrictions } from "../domains/cloud/desktop-config-provider";

function Example() {
  const config = useOrgRestrictions();
  const customProvidersRestricted = config.allowCustomProviders === false;

  return customProvidersRestricted ? <RestrictedNotice /> : <ProviderForm />;
}
```

## Helper Functions

For model/provider-specific gates, use the helpers in `apps/app/src/app/cloud/desktop-app-restrictions.ts`.

```tsx
import { isDesktopModelBlocked } from "../../app/cloud/desktop-app-restrictions";
import { useCheckDesktopRestriction } from "../domains/cloud/desktop-config-provider";

function ModelOption({ model }: { model: ModelRef }) {
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const blocked = isDesktopModelBlocked({
    model,
    checkRestriction: checkDesktopRestriction,
  });

  return <ModelRow model={model} disabled={blocked} />;
}
```

## Loading And Refresh

The provider loads cached config first, then fetches the latest config from Cloud. It refreshes on sign-in/session changes, Den settings changes, and a one-hour interval.

Manual refresh is available through `useDesktopConfig().refresh()`:

```tsx
const desktopConfig = useDesktopConfig();

await desktopConfig.refresh();
```

## Rule Of Thumb

Use these APIs in this order:

1. `useCheckDesktopRestriction()` for most feature gates.
2. `useDesktopRestriction(key)` for one-off component checks.
3. `useDesktopConfig()` when you need loading/refresh/raw config.
4. `useOrgRestrictions()` only for raw config reads.
