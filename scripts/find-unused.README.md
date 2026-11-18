# find-unused.sh

Runs [knip](https://knip.dev) with the repo's `knip.jsonc` to find unused files, dependencies and exports.

## Usage

```bash
bash scripts/find-unused.sh                    # unused files and dependencies
bash scripts/find-unused.sh --include exports  # unused exports
bash scripts/find-unused.sh --production       # code only reachable from tests
bash scripts/find-unused.sh --workspace apps/app
```

Any arguments are passed to knip. Without arguments the script runs `--include files,dependencies`.

## How the config avoids false positives

`knip.jsonc` lists the entry points knip cannot infer on its own:

- OpenCode plugins that `apps/server` loads by path (`src/opencode-plugins/*.ts`)
- Electron's main process, preloads and helper scripts (`apps/desktop/electron/*`, `apps/desktop/scripts/*`)
- Scripts run from CI, package.json, Docker or Helm (`scripts/**`, `.github/scripts/**`, `packaging/**/*.mjs`)
- Package entry points that are not `index` files (`packages/email`, `packages/world`, `packages/mcp-apps`, …)

It ignores build output, local scratch directories, and `evals/`, which is a separate pnpm workspace. Run knip from `evals/` to check it.

Some dependencies are used only as binaries, by string, or through an obfuscated require; they are listed in `ignoreDependencies` with the reason.

If knip reports a file that is used, add its entry point to `knip.jsonc` rather than ignoring the file.

## Local note

If your `.git/info/exclude` hides a directory name that also appears in the source tree (for example `new/`), knip skips those files too. Pass `--no-gitignore` in that case.
