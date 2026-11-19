# Sandboxes: choose each sandbox's models

- **Status:** generally available; `sandboxModelChoice` was retired in November 2026.
- **Deployments:** cloud only (sandbox organizations are cloud only)
- **Author:** @reachjalil

## What changes

Every sandbox organization (`/admin/sandbox-orgs`) gets an AI Gateway provider that everyone in it can use. Its
models used to be the deployment's list (`DEN_SANDBOX_GATEWAY_MODELS`), the same for every sandbox.

The **New sandbox** form's Models line is a picker, filled in with the deployment's list. A platform admin can
change it before creating the sandbox:

- The picker lists the sandbox provider's catalog models the AI Gateway supports (`DEN_SANDBOX_GATEWAY_PROVIDER`,
  OpenRouter by default). Type to search, pick up to 20, remove a chip to drop a model.
- If the catalog cannot be loaded, the picker says so and takes typed model ids instead.
- An id that is not in the catalog is refused before anything is created.
- Leaving the picker as it is creates the sandbox exactly as before.

The same choice is `modelIds` on `POST /v1/admin/sandbox-orgs` and on the admin MCP tool `den_sandbox_create`.
`GET /v1/admin/sandbox-orgs` returns `defaults.modelChoice: true` when the deployment has a sandbox model key, and
`GET /v1/admin/sandbox-orgs/models` returns the models to choose from.

Included models and Free Auto are not affected: every sandbox still gets both.

## Who it is for

Platform admins who create sandboxes. There is no switch to turn on.

## What it needs

A sandbox model key on the deployment: `OPENROUTER_MANAGEMENT_API_KEY` (one capped key per sandbox) or
`DEN_SANDBOX_GATEWAY_API_KEY` (one shared key). Without one, sandboxes get included models only and there is
nothing to choose: the form has no Models picker, `GET /v1/admin/sandbox-orgs/models` answers 404 and a request
that sends `modelIds` answers 400.

## After a sandbox is created

A sandbox's models live in the organization's AI Gateway provider, which its owner can edit in
Settings › AI Gateway.

## How to check it

No automated test covers it. By hand, on a deployment with a sandbox model key:

1. Open the **New sandbox** form: the Models line is a picker filled in with the deployment's list.
2. Remove a model, create the sandbox and join it: only the models left in the picker can be used.
3. Send `modelIds` with an id that is not in the catalog to `POST /v1/admin/sandbox-orgs`: it answers 400 naming
   the id, and no sandbox is created.
