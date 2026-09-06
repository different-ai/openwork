# OpenWork

OpenWork is a free, open-source desktop app made for sharing AI workflows. It is an open-source alternative to Claude Cowork and Codex for macOS, Windows, and Linux.

Add one OpenWork MCP to Codex, Claude Code, Cursor, or another compatible agent and reuse the same skills, MCPs, and connected services across your tools, teammates, and machines. Create something once, share it with coworkers or friends, or keep it for yourself.

The desktop app is there when you want a dedicated workspace, but it is not required. You can use OpenWork from the agent you already have. For larger organizations, the admin interface lets you publish capabilities, manage access, and configure shared or per-user connections.

[**Download OpenWork**](https://openworklabs.com/download)

<img width="1481" height="842" alt="OpenWork desktop app" src="https://github.com/user-attachments/assets/66a8dd9b-5260-488c-957d-e54331e78c1c" />

## Install with your AI agent

Already use an AI agent? Copy this prompt and paste it into Claude Code, Cursor, Codex, ChatGPT, or any agent that can run commands on your computer.

```text
Install OpenWork on my computer, set up my first workspace, and open it ready to use. Follow the steps in https://openworklabs.com/start.md?v=hero
```

1. Installs OpenWork
2. Creates your workspace
3. Opens it ready to run

## Use OpenWork from any agent

The OpenWork MCP brings your assigned skills, plugins, MCP connections, Google Workspace, and Microsoft 365 capabilities into any compatible agent.

It exposes two tools: `search_capabilities` finds what you can use, and `execute_capability` runs it. After adding the MCP, your client opens a browser so you can sign in and choose your OpenWork organization.

### Codex

```bash
codex mcp add openwork --url https://api.openworklabs.com/mcp/agent
```

### Claude Code

```bash
claude mcp add --transport http openwork https://api.openworklabs.com/mcp/agent
```

### OpenCode

Add this to `opencode.json`:

```json
{
  "mcp": {
    "openwork": {
      "type": "remote",
      "enabled": true,
      "url": "https://api.openworklabs.com/mcp/agent",
      "oauth": {}
    }
  }
}
```

### Any MCP client

Use this remote MCP server URL:

```text
https://api.openworklabs.com/mcp/agent
```

## OpenWork Den

OpenWork Den is the control plane for managing OpenWork across a team or organization.

- Provision inference at scale and control which members and teams can use each model provider.
- Invite teammates, create teams, and manage access from one place.
- Set desktop policies, restrict local model access, and control which app versions your organization can use.
- Publish skills and plugins through marketplaces, then assign them to the organization, a team, or specific people.
- Import Agent Plugins or Anthropic-compatible plugins and make their supported skills and remote MCPs available through the OpenWork MCP.

<img width="1546" height="915" alt="OpenWork Den organization control plane" src="https://github.com/user-attachments/assets/033dbbfe-5661-4f7c-869c-46278406d6cc" />

## Licensing

This repository uses a directory-split license, similar to GitLab:

- **Everything outside `ee/` is MIT** — the desktop app and core platform are open source, free for any use.
- **Everything under `ee/` (OpenWork Den — the org control plane) is under the [OpenWork EE License](ee/LICENSE)**, a source-available license. The code is public so you can audit exactly what you deploy. Production use requires an [OpenWork subscription](https://openworklabs.com/pricing), except that it is **free for organizations with up to 5 users**, **free to evaluate for 30 days at any size**, and always free for development and testing. Each `ee/` release additionally converts to MIT two years after publication.

Versions released before this license was adopted remain under their original license (FSL-1.1-MIT). See [pricing](https://openworklabs.com/pricing) and the [subscription terms](https://openworklabs.com/terms/subscription).

## Documentation

[Read the OpenWork docs.](https://openworklabs.com/docs)

## Getting started (contributors)

The fastest path from a fresh clone to a running dev build.

### Prerequisites

- **Node 24** — pinned in [`.nvmrc`](./.nvmrc) (`nvm use` picks it up).
- **pnpm 11** — pinned in `package.json` (`packageManager`); run `corepack enable` to use the pinned version automatically. Never use npm or yarn.
- **Git with DCO sign-off** — every commit needs a `Signed-off-by` trailer (`git commit -s`). See [CONTRIBUTING.md](./CONTRIBUTING.md).

### First run

```bash
git clone https://github.com/different-ai/openwork.git
cd openwork
corepack enable
pnpm install
pnpm dev   # launches the Electron desktop app with hot reload
```

### Repository layout

| Path | What lives there |
| --- | --- |
| `apps/` | the desktop app: React UI (`apps/app`), Electron shell (`apps/desktop`), and `openwork-server` (`apps/server`) (MIT) |
| `packages/` | shared core packages (MIT) |
| `ee/` | OpenWork Den — the org control plane, MCP gateway, and inference (EE License, see [Licensing](#licensing)) |
| `evals/` | executable test specs built on `@openwork/testkit` — see [`evals/README.md`](./evals/README.md) |
| `worlds/` | declarative dev/test environment definitions for `pnpm world` |
| `docs/` | operator, feature, and release docs |
| `.opencode/skills/` | repository agent skills (testing, release, Daytona, and more) |

### Testing

All executable coverage lives in `evals/specs/**/*.test.ts`; app-driving journeys use `.e2e.test.ts`.

```bash
pnpm --dir evals install --frozen-lockfile   # once
pnpm evals:pr specs/<name>.test.ts           # app-less PR-lane spec
pnpm evals:e2e <name> --local                # app-driving E2E journey, run locally
```

Runtime-observable changes need test evidence on the PR. `AGENTS.md` and [`evals/README.md`](./evals/README.md) describe the verification contract and vocabulary.

### Sending a pull request

1. Branch from `dev` (the default branch) and open your PR against `dev`.
2. Sign off every commit: `git commit -s`.
3. Keep the diff as small as possible, and include or update test evidence for runtime-observable changes.
4. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the DCO and licensing rules — contributions under `ee/` additionally require a CLA.

## Local development

For one checkout, keep using `pnpm dev`; with no extra environment variables it reuses the existing shared dev profile.

To run multiple git worktrees at once, use:

```bash
pnpm dev:worktree
```

That sets `OPENWORK_DEV_PROFILE=auto`, derives a stable profile name from the worktree path, lets Electron choose a free CDP port, and asks Vite for a free dev-server port. You can also choose a named profile, for example `OPENWORK_DEV_PROFILE=my-feature OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=0 PORT=0 pnpm dev`.

`dev:worktree` also defaults `OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN=1`. A brand-new profile has no stored credentials, so on macOS the real keychain prompts as soon as Chromium persists an authenticated cookie, and that modal blocks Electron's main loop until it is dismissed. Set `OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN=0` if you specifically want the system keychain in an isolated profile.

Dev startup prints a banner like `[openwork] dev profile=... cdp=http://127.0.0.1:9823`; use it to find the profile directory and pass the CDP URL to local tooling.

If a second instance cannot get the profile lock it now says so and exits, instead of lingering with an open CDP port and no window.

### Headless web (no Electron)

To run the OpenWork UI in a browser against a local `openwork-server` (no desktop shell):

```bash
pnpm world up dev-headless --detach
```

`pnpm dev:headless-web` is a compatibility alias for the same script. The alias
remains foreground by default and accepts `--detach`; `world up` is foreground
unless `--detach` is explicit.

This is an isolated launcher:

- Writes `tmp/headless-server.json` and never reads `~/.config/openwork/server.json`
- Authorizes the chosen workspace root automatically, and merges (never rewrites) that config on relaunch, so workspaces you add through the UI survive `--replace`
- Starts Vite + `openwork-server` with a stable owner bearer forced into the UI. Crash-restarts keep open tabs working. The privileged host token stays on the server process and is never inlined into the Vite bundle.
- Proxies Den Cloud calls same-origin: Vite serves `/api/den` (forwarded to the Den control plane) and the app pins its Den API there via `VITE_DEN_API_BASE_URL`, so Cloud calls are never CORS-blocked and stale `localStorage` base URLs are cleared on load
- Publishes an owner-only runtime manifest at `tmp/dev-headless-web.json` (`0600`), and allows browser calls to the local server only from the web app's own origins — not every site you visit
- Uses stable ports by default (web `5178`, server `8778`; falls back to free ports when taken, override with `OPENWORK_WEB_PORT` / `OPENWORK_PORT`)
- Is single-instance as `dev-headless`; stop it with `pnpm world down dev-headless` before launching it again
- Keeps Vite and the backend under one script lifecycle, so either sibling exiting stops the other instead of leaving an orphan
- In detached mode, waits for health, prints non-secret outputs and receipt/log paths, and exits

Script-specific options must follow `--`:

```bash
pnpm world up dev-headless --detach -- --replace
pnpm world up dev-headless --detach -- --replace --keep-tokens
```

`--replace` restarts the headless runtime with fresh tokens; add
`--keep-tokens` to retain the previous tokens. `--rotate-tokens` is also
accepted by this script. These are not generic `world` options.

Open the printed Web URL. Cloud sign-in in headless web uses the **copy/paste** handoff (hosted Den cannot redirect session grants back to `http://127.0.0.1`):

1. Account → Sign in (opens Den; the paste field opens in Settings)
2. Sign in on Den
3. Copy the OpenWork link / one-time code Den shows
4. Paste it under **Paste sign-in code** → Finish sign-in

Point Den at a local stack with `OPENWORK_DEV_DEN_PROXY_TARGET=http://127.0.0.1:3005` while `pnpm dev:web-local` is running. Set `OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY=0` to disable the Den wiring.

The other checked-in scripts include `worlds/headless-prod-live.ts` and
`worlds/desktop-prod-live.ts`. Both intentionally share installed production
state and require their script-specific opt-in after `--`, for example
`pnpm world up desktop-prod-live -- --allow-shared-state`. List scripts and
running receipts with `pnpm world list`. The headless
production world is hard-limited to loopback; remote-access/public-host settings
are refused because its browser session uses production credentials.


## 🌐 Web Resources & Interactive Index
- [FASHION WEEK 2025](https://learnquester.pages.dev/fashion-week-2025.html)
- [CATEGORY HERO](https://learnquester.pages.dev/category-hero.html)
- [BLOCK UP](https://learnquester.pages.dev/block-up.html)
- [SHOT CAN WILD](https://learnquester.pages.dev/shot-can-wild.html)
- [CATEGORY DRAGON22](https://learnquester.pages.dev/category-dragon22.html)
- [PRINCESSES AT HORROR SCHOOL](https://theskillquest.pages.dev/princesses-at-horror-school.html)
- [MONEY GRABBER](https://thelearnquesters.pages.dev/money-grabber.html)
- [ASMR BEAUTY CLINIC](https://learnquester.pages.dev/asmr-beauty-clinic.html)
- [CATEGORY SNAKE](https://learnquester.pages.dev/category-snake.html)
- [FIRE TRUCK DRIVING SIMULATOR](https://learnquester.pages.dev/fire-truck-driving-simulator.html)
- [CATEGORY BIKE](https://thelearnquesters.pages.dev/category-bike.html)
- [MAD DASH](https://thelearnquesters.pages.dev/mad-dash.html)
- [BLAST CUBES](https://thequizzone.pages.dev/blast-cubes.html)
- [METAL BAY TOP BLADE POWER](https://thelearnquesters.pages.dev/metal-bay-top-blade-power.html)
- [TRIPLE SORT 3D HOME DESIGN](https://learnquesters.pages.dev/triple-sort-3d-home-design.html)
- [CITY DRIFT RACING](https://thelearnquesters.pages.dev/city-drift-racing.html)
- [MASTER ADDICTION SOLITAIRE](https://learnquesters.pages.dev/master-addiction-solitaire.html)
- [DRAW TO FISH FIGHT](https://learnquester.github.io/draw-to-fish-fight.html)
- [CATEGORY INCREMENTAL388](https://learnquester.pages.dev/category-incremental388.html)
- [CATEGORY BIKE](https://learnquester.pages.dev/category-bike.html)
- [CATEGORY SURVIVAL366](https://quizverses-9d2f2.web.app/category-survival366.html)
- [INDEX7](https://studyquests.github.io/index7.html)
- [FREE HOOPS](https://learnquesters.pages.dev/free-hoops.html)
- [SUPERHERO ESCAPE RUN PARKOUR CHALLENGE](https://learnquesters.pages.dev/superhero-escape-run-parkour-challenge.html)
- [CATEGORY FASHION](https://quizverses.pages.dev/category-fashion.html)
- [THREAD SORT](https://thequizzone.pages.dev/thread-sort.html)
- [CATEGORY FASHION105](https://quizverses-9d2f2.web.app/category-fashion105.html)
- [CATEGORY COLOR197](https://studyquests.github.io/category-color197.html)
- [GREATSWORD V3](https://quizverses.pages.dev/greatsword-v3.html)
- [CRAZY BAR BRAWL](https://studyquests.github.io/crazy-bar-brawl.html)
- [CATEGORY SOCCER 2](https://studyquests.github.io/category-soccer-2.html)
- [BOO TIFUL PRINCESS MATCH](https://thequizzone.pages.dev/boo-tiful-princess-match.html)
- [ECO BLOCK PUZZLE](https://quizverses-9d2f2.web.app/eco-block-puzzle.html)
- [PAPA BUZJA](https://learnquesters.pages.dev/papa-buzja.html)
- [SNAKE HUNTER](https://studyquests.github.io/snake-hunter.html)
- [SCREW COLOR SORTING MASTER](https://quizverses-9d2f2.web.app/screw-color-sorting-master.html)
- [CAT EVOLUTION 2](https://thelearnquesters.pages.dev/cat-evolution-2.html)
- [NINJA CROSSWORD CHALLENGE](https://quizverses-9d2f2.web.app/ninja-crossword-challenge.html)
- [GUESS THE ITALIAN BRAINROT ANIMALS](https://learnquester.pages.dev/guess-the-italian-brainrot-animals.html)
- [BLOSSOM](https://quizverses.pages.dev/blossom.html)
- [BLOCK PUZZLE TROPICAL STORY](https://quizverses.pages.dev/block-puzzle-tropical-story.html)
- [TERMS](https://studyquests.github.io/terms.html)
- [CATEGORY BUBBLE SHOOTER](https://studyquests.github.io/category-bubble-shooter.html)
- [CATEGORY SURVIVAL366](https://studyquests.github.io/category-survival366.html)
- [CRASH THE ROBOT](https://studyquests.github.io/crash-the-robot.html)
- [KIRKA IO](https://thelearnquesters.pages.dev/kirka-io.html)
- [SORT PARKING](https://thequizzone.pages.dev/sort-parking.html)
- [CATEGORY DRAWING GAMES](https://studyplayings.pages.dev/category-drawing-games.html)
- [INDYGIRL AND THE GOLDEN SKULL](https://thequizzone.pages.dev/indygirl-and-the-golden-skull.html)
- [FARM BUSINESS SAGA](https://studyplaying.github.io/farm-business-saga.html)
- [SAVE BABY CAPYBARAS PULL PIN](https://quizverses-9d2f2.web.app/save-baby-capybaras-pull-pin.html)
- [WOOD NUTS MASTER SCREW PUZZLE](https://learnquester.pages.dev/wood-nuts-master-screw-puzzle.html)
- [NINJA TIME](https://studyplaying.github.io/ninja-time.html)
- [CATEGORY POOL 2](https://learnquester.pages.dev/category-pool-2.html)
- [CATEGORY RELAXING223](https://studyplayings.pages.dev/category-relaxing223.html)
- [MAGIC FINGER PUZZLE 3D](https://studyquests.github.io/magic-finger-puzzle-3d.html)
- [BANK ROBBERY 3](https://studyquests.github.io/bank-robbery-3.html)
- [SNEAKY FRIENDS](https://studyquests.github.io/sneaky-friends.html)
- [MAGIC TILES 3](https://studyquests.github.io/magic-tiles-3.html)
- [MY FIRE STATION WORLD](https://studyplaying.github.io/my-fire-station-world.html)
- [ITALIAN ANIMALS CREATE YOUR OWN BRAINROT](https://learnquesters.pages.dev/italian-animals-create-your-own-brainrot.html)
- [WORLD SOLITAIRE TRIPEAKS ](https://thelearnquesters.pages.dev/world-solitaire-tripeaks-.html)
- [CATEGORY BIKE](https://studyplayings.pages.dev/category-bike.html)
- [FARM MAHJONG 3D](https://thelearnquesters.pages.dev/farm-mahjong-3d.html)
- [CAR DESTRUCTION KING](https://learnquesters.pages.dev/car-destruction-king.html)
- [QUIZ SQUID ROUND](https://quizverses-9d2f2.web.app/quiz-squid-round.html)
- [CATEGORY STICKMAN 2](https://studyquests.github.io/category-stickman-2.html)
- [CATEGORY FPS175](https://quizverses-9d2f2.web.app/category-fps175.html)
- [CATEGORY CARDS](https://learnquester.pages.dev/category-cards.html)
- [CATEGORY TITANIUM NETWORK](https://quizverses-9d2f2.web.app/category-titanium-network.html)
- [TRAFFIC ESCAPE PUZZLE](https://thelearnquesters.pages.dev/traffic-escape-puzzle.html)
- [CANDY MAKER DESSERT GAMES](https://thelearnquesters.pages.dev/candy-maker-dessert-games.html)
- [CATEGORY CASUAL 12](https://studyquests.github.io/category-casual-12.html)
- [WATERPARK SORT](https://learnquester.pages.dev/waterpark-sort.html)
- [FRUIT GOALS MATCH](https://thelearnquesters.pages.dev/fruit-goals-match.html)
- [ZOMBIE ARENA 2 FURY ROAD](https://quizverses-9d2f2.web.app/zombie-arena-2-fury-road.html)
- [PIPE CONNECT](https://quizverses-9d2f2.web.app/pipe-connect.html)
- [DREAMY HOME](https://studyplaying.github.io/dreamy-home.html)
- [SERIOUS BRO](https://learnquester.pages.dev/serious-bro.html)
- [SHIP PARKING GAME](https://quizverses.github.io/ship-parking-game.html)
- [MOTORCYCLE RACER ROAD MAYHEM](https://quizverses.pages.dev/motorcycle-racer-road-mayhem.html)
- [DUMMIES WORLD CUP](https://studyplayings.pages.dev/dummies-world-cup.html)
- [MELON DROP FRUIT MERGE MASTER](https://studyplayings.pages.dev/melon-drop-fruit-merge-master.html)
- [KUZBASS HORROR](https://thelearnquesters.pages.dev/kuzbass-horror.html)
- [SPACE SHOOTER SPEED TYPING CHALLENGE](https://thequizzone.pages.dev/space-shooter-speed-typing-challenge.html)
- [CATEGORY CONTROLLER](https://studyquests.pages.dev/category-controller.html)
- [SPRUNKI TORCHES MAZE](https://quizverses-9d2f2.web.app/sprunki-torches-maze.html)
- [CATEGORY DRAWING GAME](https://thelearnquester.web.app/category-drawing-game.html)
- [ICONIC HALLOWEEN COSTUMES](https://studyquests.github.io/iconic-halloween-costumes.html)
- [BATTLE SIMULATOR SANDBOX](https://studyplayings.pages.dev/battle-simulator-sandbox.html)
- [CARJAMCOLOR](https://quizverses.pages.dev/carjamcolor.html)
- [ITALIAN BRAINROT FIND THE DIFFERENCES](https://thequizzone.pages.dev/italian-brainrot-find-the-differences.html)
- [IDLE BASEBALL TYCOON](https://studyquests.github.io/idle-baseball-tycoon.html)
- [INDEX19](https://studyquests.pages.dev/index19.html)
- [CATEGORY DRESS UP CATEGORY](https://studyplayings.pages.dev/category-dress-up-category.html)
- [CATEGORY DRIFTING116](https://studyquesthub.web.app/category-drifting116.html)
- [SPRUNKI BEATS](https://quizverses-9d2f2.web.app/sprunki-beats.html)
- [CATEGORY ZOMBIE175](https://thequizzone.pages.dev/category-zombie175.html)
- [CONSTRUCTION SIMULATOR](https://studyquests.github.io/construction-simulator.html)
- [IDLE LEGEND](https://thelearnquesters.pages.dev/idle-legend.html)
- [HEAT INCREMENTAL](https://studyquests.github.io/heat-incremental.html)
- [SPA EMPIRE](https://quizverses-9d2f2.web.app/spa-empire.html)
- [CLUB TYCOON IDLE CLICKER](https://studyquests.pages.dev/club-tycoon-idle-clicker.html)
- [MOJO MATCH 3D](https://studyquests.github.io/mojo-match-3d.html)
- [GOKARTS IO](https://thelearnquesters.pages.dev/gokarts-io.html)
- [THRONE VS BALLOONS](https://thelearnquesters.pages.dev/throne-vs-balloons.html)
- [CATEGORY CONTROLLER59](https://learnquester.pages.dev/category-controller59.html)
- [COSMIC AVIATOR](https://learnquester.pages.dev/cosmic-aviator.html)
- [CATEGORY BIKE](https://studyquesthub.web.app/category-bike.html)
- [KAWAII FRIENDS TILES MATCHER](https://quizverses-9d2f2.web.app/kawaii-friends-tiles-matcher.html)
- [DOGGI](https://studyquesthub.web.app/doggi.html)
- [CATEGORY UNBLOCK](https://thequizzone.pages.dev/category-unblock.html)
- [IDLE BARBER SHOP](https://studyquesthub.web.app/idle-barber-shop.html)
- [CATEGORY PHYSICS371](https://studyplayings.pages.dev/category-physics371.html)
- [BALL PAINT 3D](https://studyquests.github.io/ball-paint-3d.html)
- [WIPE INSIGHT MASTER](https://studyquests.pages.dev/wipe-insight-master.html)
- [CATEGORY IDLE448](https://studyquests.pages.dev/category-idle448.html)
- [WOODLAND SLIDE](https://learnquester.github.io/woodland-slide.html)
- [SHANGHAI CHEF](https://studyplaying.github.io/shanghai-chef.html)
- [INDEX21](https://learnquesters.pages.dev/index21.html)
- [GARDEN TALES MAHJONG 2](https://thequizzone.pages.dev/garden-tales-mahjong-2.html)
- [CATEGORY TURN BASED30](https://thequizzone.pages.dev/category-turn-based30.html)
- [STICKMAN ARCHERO FIGHT STICK SHADOW FIGHT WAR](https://learnquester.github.io/stickman-archero-fight-stick-shadow-fight-war.html)
- [CATEGORY BASKETBALL](https://quizverses-9d2f2.web.app/category-basketball.html)
- [BOLTS AND NUTS](https://thelearnquester.web.app/bolts-and-nuts.html)
- [SUPER SNIPER MISSIONS](https://thelearnquesters.pages.dev/super-sniper-missions.html)
- [CATEGORY FASHION](https://learnquester.pages.dev/category-fashion.html)
- [THE COUNTERFEIT BANK](https://learnquesters.pages.dev/the-counterfeit-bank.html)
- [INDEX11](https://learnquesters.pages.dev/index11.html)
- [LOOP SURVIVORS ZOMBIE CITY](https://studyquesthub.web.app/loop-survivors-zombie-city.html)
