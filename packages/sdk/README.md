# OpenWork Den SDK

`@openwork/sdk` is a TypeScript client for the **Den cloud API**. It is a private
workspace package for now; this change does not publish it to npm. It does not
wrap the local OpenWork server or the OpenCode engine API.

```ts
import { createDenClient } from "@openwork/sdk";

const den = createDenClient({
  apiKey: process.env.DEN_API_KEY,
  orgId: process.env.DEN_ORG_ID,
  // Defaults to https://api.openworklabs.com. Set this for a self-hosted Den.
  baseUrl: "https://api.openworklabs.com",
});

const { data, response } = await den.getV1MeOrgs({ throwOnError: true });
console.log(response.status, data.orgs);

const created = await den.postV1Teams(
  { name: "Design" },
  { throwOnError: true },
);
console.log(created.data.team.id);
```

Use `token` for a user session (`Authorization: Bearer ...`), `apiKey` for an
organization key (`x-api-key`), and `orgId` for `x-openwork-org-id`. Session-only
operations still require a session. Configure either credential as appropriate
for the operation. Each factory call owns an independent HTTP client.

Standard Fetch options, including `headers`, `signal`, and a custom `fetch`, are
accepted. Per-call header values override the factory's authentication and
organization defaults. Methods return `{ data, error, request, response }` by
default; `response` can be absent when a request fails before an HTTP response
arrives. Pass `{ throwOnError: true }` to reject on request and HTTP errors.

## Generation

OpenAPI and `src/gen` are ignored build outputs. Den's route metadata and Zod
schemas are the source of truth; no generated files are committed or merged.

After installing the workspace, start local MySQL (`pnpm dev:den:mysql`):

```sh
pnpm sdk:build     # generate when source/output changes, then compile dist
pnpm sdk:check     # force generation from source and typecheck
pnpm sdk:generate  # force generation without compiling
```

Generation builds Den's workspace prerequisites, exports its public OpenAPI
once, then runs pinned `@hey-api/openapi-ts` and Prettier. It creates, prepares
and removes its own disposable local database, including after failures. It
ignores `DATABASE_URL`; use `OPENWORK_CONTRACT_MYSQL_URL` only for alternate
localhost credentials/ports. CI generates from its checkout and validates the
result rather than comparing with committed files.

Repeated builds reuse artifacts only when both the source digest and generated
file contents match. A new route, changed dependency, missing output or edited
output triggers generation again. Update route metadata to change methods or
types; never hand-edit the generated client. A small handwritten factory wraps
that client.

Method names follow Den's existing operation IDs (for example `getV1MeOrgs`).
Types are only as precise as the server schema: routes with opaque or missing
schemas retain `unknown` fields rather than inventing contracts. Better Auth
wildcard routes and endpoints absent from Den's OpenAPI are not added manually.

The journey test needs MySQL and Redis for an isolated Den. It checks public and
authenticated calls, session and API-key identity, session organization selection
across two organizations, typed team mutations, per-request organization and
credential overrides, and failure responses.
