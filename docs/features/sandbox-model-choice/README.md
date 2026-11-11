# Sandboxes: choose each sandbox's models (`sandboxModelChoice`)

- **Key:** `sandboxModelChoice`
- **Deployments:** cloud only (sandbox organizations are cloud only)
- **Default:** off
- **Author:** @reachjalil

## What changes

Every sandbox organization (`/admin/sandbox-orgs`) gets an AI Gateway provider that everyone in it can use. Until
now its models were the deployment's list (`DEN_SANDBOX_GATEWAY_MODELS`), the same for every sandbox.

With the feature on, the **New sandbox** form's Models line becomes a picker, filled in with the deployment's
list. A platform admin can change it before creating the sandbox:

- The picker lists the sandbox provider's catalog models the AI Gateway supports (`DEN_SANDBOX_GATEWAY_PROVIDER`,
  OpenRouter by default). Type to search, pick up to 20, remove a chip to drop a model.
- If the catalog cannot be loaded, the picker says so and takes typed model ids instead.
- An id that is not in the catalog is refused before anything is created.
- Leaving the picker as it is creates the sandbox exactly as before.

The same choice is `modelIds` on `POST /v1/admin/sandbox-orgs` and on the admin MCP tool `den_sandbox_create`.
`GET /v1/admin/sandbox-orgs` returns `defaults.modelChoice: true` when it is available, and
`GET /v1/admin/sandbox-orgs/models` returns the models to choose from.

Included models and Free Auto are not affected: every sandbox still gets both.

## Who it is for

Platform admins who create sandboxes. The flag is read for the whole deployment (it has no organization yet when a
sandbox is being created), so turn it on under **Everyone** in `/admin` › Features. An organization override does
nothing.

## What it needs

A sandbox model key on the deployment: `OPENROUTER_MANAGEMENT_API_KEY` (one capped key per sandbox) or
`DEN_SANDBOX_GATEWAY_API_KEY` (one shared key). Without one, sandboxes get included models only and there is
nothing to choose.

## Turning it off

New sandboxes get the deployment's list again, and a request that sends `modelIds` answers 400. Sandboxes that
were created with their own list keep it: their models live in the organization's AI Gateway provider, which its
owner can edit in Settings › AI Gateway whether the feature is on or off.

## How to check it

`ee/apps/den-api/test/api/sandbox-organizations-models.api.test.ts` covers the list of models to choose from, a
sandbox created with its own list, an unknown model id, and the feature being off.
