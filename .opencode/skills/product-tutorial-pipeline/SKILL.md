---
name: product-tutorial-pipeline
description: Reproduce or refresh a product tutorial with polished screenshots end-to-end — cloud dashboard flows, desktop app flows, Screen.Studio-style framing, tutorial doc, PR. Use when asked to "redo the tutorial", "refresh tutorial screenshots", "make a tutorial/walkthrough with screenshots", or to document a cloud + desktop flow like the OpenWork Cloud team quickstart.
---

# Product Tutorial Pipeline

The end-to-end recipe behind `packages/docs/cloud/team-quickstart.mdx`.
Follow it to refresh that tutorial after product changes or to produce a new
one. Companion skills: `cloud-dashboard-walkthrough` (web flows),
`daytona-electron-den` (desktop), `agent-first-screenshots` (capture quality
bar + beautifier).

## 0. Branch

Fresh worktree from latest dev — never the user's checkout:

```bash
git fetch origin
git worktree add ../_worktrees/<name> -b docs/<tutorial-branch> origin/dev
```

## 1. Stand up the product

- **Cloud**: `bash .devcontainer/test-server-on-daytona.sh dev --name <name>`
  → Den Web/API URLs. Verify `orgMode:"multi_org"` via `/api/runtime-config`.
- **Desktop**: `bash .devcontainer/test-on-daytona.sh dev
  --den-base-url <DEN_WEB_URL> --den-api-base-url <DEN_API_URL>` → Electron
  CDP + noVNC URLs. Resize the window from the renderer for generous shots:
  `window.resizeTo(1600, 1000)`.
- Do NOT run the desktop app locally on macOS from an agent shell —
  `app.whenReady()` never fires (window-server/keychain quirk); the Daytona
  Electron sandbox is the paved path.
- Provider keys for real model runs come from the `openwork-eval-secrets`
  volume (mounted automatically) or Infisical (`get-env-var` skill).

## 2. Drive and capture

Walk the flows as the persona (e.g. owner "Simon Green" of "Acme Labs"), one
tutorial beat per screenshot. Quality bar and verification loop live in
`agent-first-screenshots`. Practical rules that mattered:

- Capture at 2x (`--force-device-scale-factor=2` Chrome; Electron sandbox is
  1x — fine after downscaling to 1600px).
- Fill forms *before* shooting them; screenshots of filled forms teach better.
- Hide dev-only chrome only: `nextjs-portal` badge (web), "Connected to
  <sandbox-url>" + "Daytona folder path" boxes (desktop welcome).
- Close stray panels via their real close buttons before shooting.
- Name raws by step: `raw/01-signin-email.png … raw/NN-final.png`.

Desktop-specific moves (details in `daytona-electron-den`): sign in by
dispatching the handoff deep link event; verify org extensions at
`#/workspace/<ws>/settings/cloud-marketplaces`; insert composer prompts with
`document.execCommand("insertText", …)` (never synthetic paste — it becomes an
attachment chip); wait for "Ready for new tasks" before the final shot.

## 3. Beautify

Frame every raw with the repo beautifier
(`.opencode/skills/agent-first-screenshots/scripts/beautify.mjs`). House
style:

```bash
# cloud/dashboard shots — browser chrome with the canonical URL
node beautify.mjs raw/NN.png out/NN.png \
  --chrome browser --url app.openworklabs.com --bg paper --width 1600

# desktop shots — macOS chrome, contrasting background
node beautify.mjs raw/NN.png out/NN.png \
  --chrome mac --title OpenWork --bg indigo --width 1600
```

Run from a repo root that has `node_modules` (the script resolves `sharp`
from the pnpm store). Spot-check outputs visually before writing the doc.

## 4. Write the doc

- Doc: `packages/docs/<tab>/<name>.mdx` with `title` and `description`
  frontmatter.
- Images: `packages/docs/images/<tutorial-name>/NN-step.png`; reference them
  absolute as `/images/<tutorial-name>/…` and wrap each in `<Frame>`.
- Register the page in `packages/docs/docs.json` under the right tab/group.
- One image per beat, numbered in flow order; short imperative sections that
  mirror the product's exact labels (**Add member**, **Create plugin**, …).
- Verify every referenced image exists:

  ```bash
  for img in $(grep -oE '/images/[a-z0-9/-]+\.png' packages/docs/<tab>/<name>.mdx); do
    [ -f "packages/docs$img" ] || echo "MISSING: $img"; done
  ```

## 5. Ship

Commit in story-shaped commits (fixes discovered along the way separate from
docs), push, open a PR against `dev` with `gh pr create`, and embed 2–3 key
screenshots in the PR body via `raw.githubusercontent.com/<org>/<repo>/<branch>/packages/docs/images/...`
links. State exactly what was validated (driven E2E) and what tests ran.

## Cleanup

`daytona delete <server-sandbox> <electron-sandbox>` when done; kill local
headless Chromes (`pkill -f remote-debugging-port=9223`).
