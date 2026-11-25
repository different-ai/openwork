# Models in the desktop Library (`desktopLibraryModels`)

- **Feature key:** `desktopLibraryModels`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @benjaminshafii

## What people get

The desktop Library gets a **Models** filter, after Plugins. It lists the
models your organization gives you, one row per provider, like the Models
section of the Library in the web app.

- A provider you can already use shows as Ready, with its model names.
- A provider that needs your own sign-in (Google, AWS, Microsoft or your
  account) shows **Sign in** and counts toward **Needs sign-in**. Sign in opens
  the same browser sign-in as Settings › AI providers. While it waits, the row
  says so and offers Cancel.
- A provider your organization blocked says so.
- Clicking a Ready row opens Settings › AI providers.

With the feature off, or signed out of OpenWork Cloud, the Library shows no
models and no Models filter.

## Turn it on locally

Turn the flag on for your organization in `/admin` (org override), or lock it
on for a self-hosted Den with `DEN_FEATURE_DESKTOP_LIBRARY_MODELS=true`.

## Where it lives

- `apps/app/src/react-app/domains/settings/library-models.ts` builds the rows
  from the provider-auth store (live Gateway providers, synced providers and
  providers waiting on your sign-in).
- `apps/app/src/react-app/domains/settings/pages/mcp-view.tsx` renders them.
- `apps/app/src/react-app/shell/settings-route.tsx` reads the flag and wires
  Sign in to the existing Gateway sign-in.
- Test: `apps/app/tests/library-models.test.ts`.
