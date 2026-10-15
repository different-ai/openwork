---
name: preview-my-work
description: Boot, reopen, update, or reset OpenWork PR previews and demos - preview-desktop, preview-den, preview-full, preview-app-web, preview-workbot, acme-web - locally, on a private Daytona URL, or on Freestyle. Also a long-lived seeded Acme Robotics demo with demo credentials.
---

# Preview my work

Previews are disposable worlds, never production or a person's installed app. Run from the requested worktree. Per **Use the Maintained Lever**, the world CLI is the source of truth: it knows every world, placement, seed, source, credential fix and caveat.

## Ask the CLI

1. `pnpm world help --json` lists worlds. `pnpm world help <world> --json` gives targets, seeds and their meanings, default sources, requirements with fixes, ready commands by intent, and caveats. Start from one of its examples.
2. `pnpm world plan <world> --place <place> --stage <stage>` creates nothing and exits 1 with the fix while a requirement is unmet.
3. `pnpm world outputs <world> --stage <stage> --json` shows an existing world. `{"exists": false}` means nothing to reopen.
4. `pnpm world up ...` rechecks before any side effect.

Credentials follow **Scope Secrets**. The requirement `fix` in `help` prints the exact one-command form.

Act on what the CLI prints:

- `plan --place daytona` names its identity. Fix a ⚠ (personal org, ignored key) before a two-sandbox world.
- `source  <short sha> (origin/dev) <subject>` is the commit being built. Report it with the link, unasked.
- `note  this checkout's world recipes differ from <sha>` means stale recipes. Rerun from the worktree it names.
- `hint:` lines after a failed `up` name the cause. Fix it. Never retry unchanged.

## Rules the CLI cannot enforce

- To check your own change on this computer, start with `pnpm world up dev-app-web --detach -- --browser`: headless, with a `cdp` address to attach to. A `--place local` world with a desktop opens a window that takes focus here. Use one only when asked or when the change needs the desktop shell; otherwise use Daytona.
- Use a pushed full SHA for explicit sources. Cold builds take minutes. Never promise seconds.
- App settings: export the key, then `--env KEY` before `--`. Never pass credentials, tokens, profiles or secrets volumes.
- `preview-app-web` Den proxy: only `OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY` plus `OPENWORK_DEV_DEN_PROXY_TARGET`, selected together. Remote targets allow only `https://app.openworklabs.com`.
- `webUrl` and other `--reveal` outputs are secret. Open them privately. Never put them in a PR or evidence.
- Seeded worlds have no model credentials and in-memory demo apps. Never claim live model calls or sign-in were verified. Mail stays in the dev outbox.
- Per **Prove It on the Real Thing**, a booted preview is not a passing test (`run-tests`).

## Seeded demo to hand to someone

```sh
pnpm world up preview-den --place daytona --stage demo-<date> --seed team --detach --timeout 600000 -- --lifetime 0
pnpm world outputs preview-den --stage demo-<date> --reveal     # Den URL and the alex@acme.test password
```

Acme Robotics, owner Alex Chen, with demo Slack, Notion, Linear, Calendar and Gmail. `--lifetime 0` keeps it until `down`, with no keepalive needed. Sign in once yourself before handing over the URL and credentials directly to the person. Use `preview-full --seed workspace` for a signed-in desktop, or `acme-web` on Freestyle.

## Open and hand over

- Wait for readiness and confirm the preview responds.
- Open `preview` with `open_in_codex` when available, else give the link. Desktop previews open a noVNC viewer. Keep `denWeb` handy.
- Seeded Den: sign in with the test account first. Leave `fresh` at signup.
- Per **Thirty-Second Reader**, report the link, the `source` line, seed, expiry and real limitations. Leave out sandbox IDs, secrets and logs.

## Update, reopen, reset, stop

- Frontend-only change: push, then `pnpm exec python3 .opencode/skills/preview-my-work/scripts/update-preview.py <world> --stage <stage> --ref <pushed-sha>`. It updates Den web (`preview-den`), Den web plus the desktop renderer (`preview-full`), or the renderer (`preview-desktop`). Data, accounts and the Electron process survive. Verify the screen changed.
- It does not restart Den API, migrate, restart Electron main/preload, or touch app-web and release previews. For those, launch a new stage and say it is fresh.
- Per **Touch Only What You Own**, a stage is not a git ref. Reopen a matching world after comparing its recorded seed, source and release. Adoption is never an update.
- Start over: `pnpm world down <world> --stage <stage>`, then relaunch. This deletes data. Use another stage to compare.
- Lifetime is 2 h from readiness, not idle. `--lifetime 0` only when asked to keep it. A killed driver leaves sandboxes; remove them only by the IDs in the owner-only outputs.

## Saved web evidence checkpoints

Specs tagged `checkpoints` save explicit checkpoints in the PR's **OpenWork Evidence** report. **Open from here**, then **Enter saved browser**, forks a private VM; **New copy** restores the original; **Continue response** resumes a held mock. Checkpoints expire after 24 h; forks last 1 h, three per checkpoint. Live provider connections are not restored. Proof run: `pnpm --filter @openwork/review-app build && pnpm evals:e2e web-checkpoint-fork --local --engine v1 --surface web --checkpoints` (host needs `FREESTYLE_API_KEY`).
