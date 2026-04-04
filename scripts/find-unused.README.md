# find-unused.sh

Wrapper around [knip](https://knip.dev) that detects unused files and cross-references them against CI configs, build configs, package.json scripts, tsconfig files, convention-based usage, file-based routing directories, and sibling repo CI/CD pipelines to reduce false positives.

## Usage

```bash
bash scripts/find-unused.sh
```

Requires `npx` (knip is fetched automatically). A fake `DATABASE_URL` is injected so config resolution doesn't fail.

The script auto-detects whether it's running inside a factory layout (`../../.._repos/`). When inside a factory, it cross-references sibling repos. When standalone, it skips sibling checks gracefully and still runs all internal checks.

## What it does

1. **Runs `knip --include files`** to get a list of unused files across the monorepo.
2. **Indexes infra files** — collects all build/config/CI files into a single searchable set:
   - GitHub workflow YAMLs
   - Dockerfiles and docker-compose files
   - Deployment configs (Vercel, Tauri)
   - Build tool configs (vite, tailwind, postcss, next, drizzle, tsup, playwright)
   - Build scripts (`.mjs`, `.ts`, `.sh` across all workspaces)
   - `.opencode` skill scripts
   - All `package.json` files (for script references)
   - All `tsconfig*.json` files (for path aliases and includes)
3. **Cross-references** each file against:
   - **Internal infra** — all indexed config/build files, searching by filename and relative path
   - **Convention patterns** — filenames like `postinstall`, `drizzle.config`, Tauri hooks
   - **File-based routing dirs** — Next.js server routes, app routes, and API routes that are entry points by convention
   - **Sibling repo CI/CD** — workflows, Dockerfiles, and build scripts in sibling repos and factory-level CI, with smart filtering to avoid false positives on generic filenames (e.g., `index`, `utils`, `config`)
4. **Displays results in two buckets** (oldest first within each):
   - `✗` **Safe to remove** — no references found anywhere (red)
   - `⚠` **Review before removing** — referenced in infra/CI (yellow) or sibling CI (cyan)

A progress indicator shows the current file being checked during cross-referencing.

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
