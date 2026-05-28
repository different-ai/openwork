# Desktop App Policies

Desktop app policy config is loaded from OpenWork Cloud through `GET /v1/me/desktop-config` and exposed inside the desktop app through `DesktopConfigProvider`.

App code should read policy state through the hooks in `apps/app/src/react-app/domains/cloud/desktop-config-provider.tsx`. Do not read the provider's internal refs directly; those are only used to compare and apply newly loaded config safely.

## Policy Keys

The canonical policy catalog lives in `packages/types/src/den/desktop-policies.ts` as `desktopPolicyDefinitions`. Add or change policy items there first so the API, Den web, and desktop app share the same IDs and copy.

Do not duplicate the list of policy IDs in app docs or feature code unless a feature is intentionally checking a specific policy. Import from the shared package when you need the full catalog.

`allowedDesktopVersions` is part of the desktop config response but is not a boolean policy item in `desktopPolicyDefinitions`.

For boolean policy keys, `false` means the feature is restricted or disabled. `true` or `undefined` means the app should not block the feature locally.

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
