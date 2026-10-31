---
name: verify-openwork
description: Prove an OpenWork change works on the real product before calling it done. Start the product, drive the change the way a user or client would, capture screenshots, and show the proof fails on dev and passes on your branch. Use before opening a PR, when a reviewer asks "show me", or when a core journey is red.
---

# Verify OpenWork

A change is done when you have watched it work on the real product, not when it
compiles. The committed e2e suite is only the nine core journeys in
`evals/journeys.ts`; everything else is proved per PR and thrown away.

## 1. Pick the check

| The change is… | Prove it with |
| --- | --- |
| a server rule (permissions, isolation, validation, secrets) | an API test next to the code, e.g. `ee/apps/den-api/test/api/*.api.test.ts` (`pnpm --filter @openwork-ee/den-api test:api`) |
| a pure function or component logic | a colocated unit test |
| something a person or client does end to end | a proof: `evals/proofs/<name>.proof.test.ts` (`write-a-spec`) |
| one of the nine core journeys broke or changed | a step in that journey, `evals/core/<journey>.e2e.test.ts` |

## 2. Start the product

```bash
pnpm world up dev-app-web --detach -- --browser   # this checkout in headless Chrome; prints webUrl and cdp
pnpm world down dev-app-web                        # when done
```

Use a desktop window only for desktop-shell changes (see `drive-desktop-cdp`).
Den needs MySQL and Redis on localhost (`pnpm dev:den:mysql`, or a local MySQL
via `OPENWORK_EVAL_MYSQL_URL=mysql://root@127.0.0.1:3306`).

## 3. Drive it and keep the evidence

- By hand while working: `drive-desktop-cdp` (new session, send, wait, screenshot).
- As a proof: `pnpm evals:e2e <name> --local`; screenshots and the report land in
  `evals/results/test-runs/<latest>/`.

Drive the real user path. No internal setters, no test-only endpoints, no
reading app state; `pnpm --dir evals lint:specs` rejects those in proofs.

## 4. Show it fails without your change

A proof that passes on `dev` proves nothing about your change. Run it on both:

```bash
git worktree add /tmp/ow-base origin/dev
cp evals/proofs/<name>.proof.test.ts /tmp/ow-base/evals/proofs/
(cd /tmp/ow-base && pnpm install --frozen-lockfile && pnpm evals:e2e <name> --local)   # must fail
pnpm evals:e2e <name> --local                                                           # must pass
git worktree remove /tmp/ow-base
```

If it passes on `dev`, the assertion is looser than the change: tighten it.

## 5. Hand it over

Open the PR with `open-a-pr`. CI runs your proof and the core-chat journey on
the PR head and posts the evidence; the other core journeys run on every `dev`
push and nightly ("Core journeys"), and on a PR only when it changes them. Name the proof and its before → after in
the PR's Evidence section.

## The nine core journeys (feature map)

| Journey | What it proves | Run |
| --- | --- | --- |
| `org-invite-join` | an owner invites someone and they join with the right role | `pnpm evals:e2e org-invite-join --local` |
| `core-chat` | a signed-in person sends a message and reads the reply | `pnpm evals:e2e core-chat --local` |
| `thread-continues-after-restart` | a conversation, queued follow-up and draft survive a restart | desktop; `pnpm evals:e2e thread-continues-after-restart --local` |
| `agent-connection-journey` | a connector call in chat shows what was called and what came back | `pnpm evals:e2e agent-connection-journey --local` |
| `agent-permissions` | blocked commands stay blocked; allowed ones run | `pnpm evals:e2e agent-permissions --local` |
| `app-smoke` | the packaged desktop app opens to a working screen | packaged smoke (`apps/desktop/scripts/packaged-smoke.mjs`) |
| `packaged-update-install` | an installed app downloads and installs a newer build | macOS packaged smoke |
| `agent-signup-via-mcp` | an MCP client connects, searches capabilities and runs one | `pnpm evals:e2e agent-signup-via-mcp --local` |
| `secure-keys-in-chat` | keys stay out of the transcript, model, logs and other members' calls | `pnpm evals:e2e secure-keys-in-chat --local` |
