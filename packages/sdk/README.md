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

const { data, error, response } = await den.getV1MeOrgs();
if (error) throw error;
console.log(response.status, data?.orgs);

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
default; pass `{ throwOnError: true }` to an operation to reject on HTTP errors.

## Generation

From the repository root, after `pnpm install`, use a local development MySQL
database with the current Den schema (`DATABASE_URL` selects it). The SDK CI job
creates its own empty database and applies the schema before generation.

```sh
pnpm sdk:generate  # export live Den OpenAPI and regenerate src/gen
pnpm sdk:check     # regenerate in a temporary directory, compare, typecheck
pnpm sdk:build     # compile JavaScript and declarations into dist
pnpm --dir evals install
pnpm evals:pr specs/den-sdk.test.ts
```

This follows [OpenCode's SDK build](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/script/build.ts):
export the server's OpenAPI document, run pinned `@hey-api/openapi-ts` 0.90.10
with TypeScript, instance SDK, flat parameters, and Fetch client plugins, format
with pinned Prettier, then compile. A small handwritten factory wraps the generated client.

The source of truth is Den's route metadata and Zod schemas, exported by
`ee/apps/den-api/scripts/generate-openapi-snapshot.ts`. Generation builds the MCP
app assets required by Den's module imports. It does not start an HTTP server,
but loading the app initializes OAuth's resource registry, which requires the
development database. The temporary OpenAPI file is removed afterward; the docs
snapshot is left untouched. `src/gen` is committed and must never be edited by
hand. CI rejects drift after schema changes. Add or improve the route's OpenAPI
metadata before regenerating to change SDK methods or types.

Method names follow Den's existing operation IDs (for example `getV1MeOrgs`).
Types are only as precise as the server schema: routes with opaque or missing
schemas retain `unknown` fields rather than inventing contracts. Better Auth
wildcard routes and endpoints absent from Den's OpenAPI are not added manually.

The journey test needs MySQL and Redis for an isolated Den. It checks public and
authenticated calls, session and API-key identity, session organization selection
across two organizations, typed team mutations, per-request organization and
credential overrides, and failure responses.
