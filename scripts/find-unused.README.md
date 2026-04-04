# find-unused.sh

Wrapper around [knip](https://knip.dev) that detects unused files and cross-references them against CI configs, package.json scripts, convention-based usage, and file-based routing directories to reduce false positives.

## Usage

```bash
bash scripts/find-unused.sh
```

Requires `npx` (knip is fetched automatically). A fake `DATABASE_URL` is injected so config resolution doesn't fail.

## What it does

1. **Runs `knip --include files`** to get a list of unused files across the monorepo.
2. **Cross-references** each file against:
   - **CI / infra configs** — GitHub workflows, Dockerfiles, Vercel configs, Turbo config, Tauri config
   - **package.json scripts** — all workspace `package.json` files
   - **Convention patterns** — filenames like `postinstall`, `drizzle.config`, Tauri hooks
   - **File-based routing dirs** — Nuxt/Next server routes and API routes that are entry points by convention
3. **Outputs a sorted list** (oldest first) with two categories:
   - `✗` **Likely safe to remove** — no references found anywhere
   - `⚠` **Review before removing** — referenced in CI, infra, convention, or routing

Certain paths are ignored entirely (scripts, dev tools) — see the `IGNORE_PREFIXES` array in the script.

## Using knip directly

The script only checks for unused **files**. Knip can detect much more — run it directly for deeper analysis:

```bash
# Unused exports (functions, types, constants)
npx knip --include exports

# Unused dependencies in package.json
npx knip --include dependencies

# Everything at once
npx knip

# Scope to a single workspace
npx knip --workspace apps/app

# Auto-fix removable issues (careful — modifies files)
npx knip --fix
```

See the [knip docs](https://knip.dev) for the full set of options.
