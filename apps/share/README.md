# OpenWork Share Service (Publisher)

This is a Next.js publisher app for OpenWork "share link" bundles.

It keeps the existing bundle APIs, but the public share surface now runs as a simple Next.js site backed by Vercel Blob.

## Endpoints

- `GET /`
  - Human-friendly packaging page for OpenWork worker files.
  - Supports drag/drop of skills, agents, commands, `opencode.json[c]`, and `openwork.json`.
  - Previews the inferred bundle and publishes a share link.

- `POST /v1/bundles`
  - Accepts JSON bundle payloads.
  - Stores bytes in Vercel Blob.
  - Returns `{ "url": "https://share.openwork.software/b/<id>" }`.

- `POST /v1/package`
  - Accepts `{ files: [{ path, name?, content }], preview?: boolean }`.
  - Parses supported OpenWork files into the smallest useful bundle shape.
  - Returns preview metadata when `preview` is `true`.
  - Publishes the generated bundle and returns the share URL otherwise.

- `GET /b/:id`
  - Returns an HTML share page by default for browser requests.
  - Includes an **Open in app** action that opens `openwork://import-bundle` with:
    - `ow_bundle=<share-url>`
    - `ow_intent=new_worker` (desktop OpenWork converts single-skill bundles into a destination picker before import)
    - `ow_source=share_service`
  - Also includes a web fallback action that opens `PUBLIC_OPENWORK_APP_URL` with the same query params.
  - Returns raw JSON for API/programmatic requests:
    - send `Accept: application/json`, or
    - append `?format=json`.
  - The canonical raw endpoint is `/b/:id/data`.
  - Supports `/b/:id/data?download=1` and the legacy `?format=json&download=1` compatibility path.

## Bundle Types

- `skill`
  - A single skill install payload.
- `skills-set`
  - A full skills pack (multiple skills) exported from a worker.
- `workspace-profile`
  - Full workspace profile payload (config, MCP/OpenCode settings, commands, skills, and agent config).

## Packager input support

- Skill markdown from `.opencode/skills/<name>/SKILL.md`
- Agent markdown from `.opencode/agents/*.md`
- Command markdown from `.opencode/commands/*.md`
- `opencode.json` / `opencode.jsonc` (only `mcp` and `agent` sections are exported)
- `openwork.json`

The packager rejects files that appear to contain secrets in shareable config.

## Required Environment Variables

- `BLOB_READ_WRITE_TOKEN`
  - Vercel Blob token with read/write permissions.

## Optional Environment Variables

- `PUBLIC_BASE_URL`
  - Default: `https://share.openwork.software`
  - Used to construct the returned share URL.

- `MAX_BYTES`
  - Default: `262144` (256KB)
  - Hard upload limit.

- `OPENWORK_PUBLISHER_ALLOWED_ORIGINS`
  - Optional comma-separated browser origins allowed to publish bundles.
  - Defaults include the share origin, the hosted OpenWork app origin, and common local dev origins.

- `PUBLIC_OPENWORK_APP_URL`
  - Default: `https://app.openwork.software`
  - Target app URL for the Open in app action on bundle pages.

- `LOCAL_BLOB_DIR`
  - Optional local filesystem storage root for bundle JSON.
  - When `BLOB_READ_WRITE_TOKEN` is unset in local/dev mode, the service falls back to local file storage automatically.

## Local development

For local testing you can use:

```bash
pnpm install
pnpm --dir apps/share dev
```

Open `http://localhost:3000`.

Without a `BLOB_READ_WRITE_TOKEN`, local development now stores bundles on disk in a local dev blob directory so publishing works out of the box.

## Deploy

Recommended project settings:

- Root directory: `apps/share`
- Framework preset: Next.js
- Build command: `next build`
- Output directory: `.next`
- Install command: `pnpm install --frozen-lockfile`
- Enable Vercel BotID for the project and keep the bundle routes protected in `app/layout.tsx`.

## Tests

```bash
pnpm --dir apps/share test
```

## Quick checks

```bash
# Human-friendly page
curl -i "http://localhost:3000/b/<id>" -H "Accept: text/html"

# Machine-readable payload (OpenWork parser path)
curl -i "http://localhost:3000/b/<id>/data"

# Legacy compatibility path
curl -i "http://localhost:3000/b/<id>?format=json"
```

## Notes

- Links are public and unguessable (no auth, no encryption).
- Do not publish secrets in bundles.
