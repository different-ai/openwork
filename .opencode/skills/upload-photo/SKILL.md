---
name: upload-photo
description: upload a photo/image/screenshot, host an image, get a public image URL, put images on Vercel Blob, embed images in a PR/comment/doc. Upload local images to Vercel Blob and print public URLs.
---

# Skill: upload-photo

Upload local image files to Vercel Blob and return public URLs for sharing.

## When to use

Use whenever an image or screenshot needs a public URL, including PR comments, docs, and sharing.

## Requires

`BLOB_READ_WRITE_TOKEN` must be set in the environment. If it is missing, use the `get-env-var` skill to fetch it from Infisical:

```bash
export BLOB_READ_WRITE_TOKEN="$(infisical secrets get BLOB_READ_WRITE_TOKEN --plain --silent)"
```

## Upload

Run the bundled script from the repo root:

```bash
node .opencode/skills/upload-photo/scripts/upload.mjs <file.png> [more files...] [--prefix <path/prefix>] [--stable]
```

It prints one public URL per line (`https://<store>.public.blob.vercel-storage.com/...`). `--prefix` defaults to `uploads/<YYYY-MM-DD>`. By default Vercel Blob appends a random suffix to the pathname for collision safety; `--stable` disables that (`x-add-random-suffix: 0`) for deterministic URLs, so overwrites are possible.

## Embed

Use Markdown:

```markdown
![alt](url)
```

Or HTML for size control in GitHub comments:

```html
<img src="url" width="700">
```

## Rules

- Never log `BLOB_READ_WRITE_TOKEN`.
- The store is public; do not upload anything sensitive.
- Prefer PNG, JPEG, or WebP images.
