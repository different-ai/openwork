# Scenarios

Start with the feature you want to demonstrate or test. Everything for onboarding
is in [onboarding/](onboarding/).

```text
scenarios/
  onboarding/
    world.ts         environment and synthetic users
    workflow.ts      ordinary async TypeScript: the user's actions
    e2e.test.ts      assertions against UI and server witnesses
    screenshots.ts  documentation captures using DocShot
    video.tsx        ordinary React/Remotion composition
    empty-chat.tsx   illustrated ending, specific to this scenario
    remotion.tsx     standard Remotion entry
    render.mjs      command to render a completed capture
```

Files are optional. Reuse a workflow from tests, recordings, or screenshots;
do not copy the journey into each output. Workflows return observations, while
tests make claims about those observations. No registration wrappers or custom
presentation language are needed.

## Find and run

Install both workspaces from the repository root:

```sh
pnpm install
pnpm --dir evals install
node evals/bin/evals.mjs --list
```

The scenarios package belongs to the evals workspace so it shares the existing
testkit and behavior packages. Presentation components belong to the root workspace.

Run onboarding (Daytona when authenticated; the CLI prints placement):

```sh
OPENWORK_EVAL_FILM_DIR="$PWD/evals/results/onboarding-capture" pnpm evals:e2e onboarding
pnpm --dir scenarios onboarding:render "$PWD/evals/results/onboarding-capture"
```

Use a new capture directory for each run. Without the directory override, the world
uses its own temporary directory. The journey has isolated Den accounts and an
isolated email outbox; it downloads the public Linux installer from GitHub.
It does not authorize Notion or Linear accounts or install the desktop app.

Outputs: `capture.json`, `frames/*.jpg`, `downloads.json`,
`screenshots/download.png`, and (after rendering) `onboarding.mp4`.
The test's assertion evidence remains under `evals/results/test-runs/`.

Render a review frame with `--still=300`. The renderer accepts
`REMOTION_BROWSER_EXECUTABLE` when a specific Chrome executable is needed.
The browser remains full screen. Frame timestamps control playback; recorded
typing is not accelerated. The last eight seconds hold the completed download
and illustrate opening an empty chat. That illustration is not proof of installation.

## Reuse existing pieces

| Need | Start here |
| --- | --- |
| Existing environment | `worlds/` and `evals/worlds/` |
| User, probe, and evidence channels | `evals/packages/testkit/` |
| Paced field input | `typeField`, `readableTyping` from `@openwork/behaviors` |
| Browser recording and download events | `captureBrowserFilm` from `@openwork/cdp` |
| Settled documentation screenshots | `evals/docs-shots/gate.ts` and `loop.ts` |
| Browser frame and recording playback | `packages/presentation/` |

`world.ts` configures an existing world factory. Keep provisioning machinery in
the existing packages. Use `await typeField(user, target, value)` for one complete
field at a time; it focuses once, replaces existing text, types graphemes with a
deterministic cadence, and verifies the final value. Set `sensitive: true` for
password inputs; the driver requires masking and excludes the value from its trace.

Existing DocShot scene IDs remain discoverable through
`node evals/docs-shots/run.ts --list`. The onboarding screenshot reuses that
engine on its already-open browser, avoiding a second provisioned environment.

## Add another scenario

Create a named folder and export plain functions. Add `e2e.test.ts` only for a new
user journey, using `spec.world` from the existing testkit. Scenario tests use the
same CLI, channel rules, boundary checks, and evidence publisher as
legacy specs. The secret-bearing Daytona PR workflow retains its existing legacy-spec
selection; it does not automatically select scenario tests. Run a scenario explicitly
with the CLI and publish its evidence on the PR. Tests are discovered by filename without importing workflows.

For an attached live-service check, use `live.test.ts` and name it explicitly:
`pnpm evals:pr ../scenarios/<name>/live.test.ts`. Declare the existing testkit's
requirements and consent variables; missing dependencies must report a skip.
Live checks stay out of default suites. No placeholder scenarios are registered.

Keep pure helper tests beside their implementation in shared packages, outside
scenario journey folders. The older `evals/specs/` tests continue to work; migrate
them only when their scenario is being worked on.
