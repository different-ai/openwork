# OpenWork Share Service (Publisher)

This is a tiny publisher service for OpenWork "share link" bundles.

It is designed to be deployed on Vercel and backed by Vercel Blob.

## Endpoints

- `POST /v1/bundles`
  - Accepts JSON bundle payloads.
  - Stores bytes in Vercel Blob.
  - Returns `{ "url": "https://share.openwork.software/b/<id>" }`.

- `GET /b/:id`
  - Returns an HTML share page by default for browser requests.
  - Returns raw JSON for API/programmatic requests:
    - send `Accept: application/json`, or
    - append `?format=json`.
  - Supports `?format=json&download=1` to download the bundle as a file.

## Required Environment Variables

- `BLOB_READ_WRITE_TOKEN`
  - Vercel Blob token with read/write permissions.

## Optional Environment Variables

- `PUBLIC_BASE_URL`
  - Default: `https://share.openwork.software`
  - Used to construct the returned share URL.

- `MAX_BYTES`
  - Default: `5242880` (5MB)
  - Hard upload limit.

## Local development

This repo is intended for Vercel deployment.
For local testing you can use:

```bash
cd services/openwork-share
pnpm install
vercel dev
```

## Quick checks

```bash
# Human-friendly page
curl -i "http://localhost:3000/b/<id>" -H "Accept: text/html"

# Machine-readable payload (OpenWork parser path)
curl -i "http://localhost:3000/b/<id>?format=json"
```

## Notes

- Links are public and unguessable (no auth, no encryption).
- Do not publish secrets in bundles.
