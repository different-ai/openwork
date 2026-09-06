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
- [SUPER ROCK CLIMBER](https://thelearnquesters.pages.dev/super-rock-climber.html)
- [JUMP BALL CLASSIC](https://studyplaying.github.io/jump-ball-classic.html)
- [PRIVACY](https://cryptotify.web.app/privacy.html)
- [CATEGORY AGILITY](https://quizverses-9d2f2.web.app/category-agility.html)
- [CATEGORY MATCH 3](https://studyquesthub.web.app/category-match-3.html)
- [CATEGORY CASUAL](https://studyquesthub.web.app/category-casual.html)
- [HAPPY ASMR CARE](https://quizverses.github.io/happy-asmr-care.html)
- [BITBALL](https://studyquesthub.web.app/bitball.html)
- [CATEGORY MOBILE2 095](https://studyquesthub.web.app/category-mobile2-095.html)
- [BELOTE 3IN1](https://studyquests.github.io/belote-3in1.html)
- [YUMMY TALES 4](https://quizverses.pages.dev/yummy-tales-4.html)
- [CATEGORY STRATEGY](https://quizverses.github.io/category-strategy.html)
- [TRAFFIC LIGHT SIMULATOR 3D](https://quizverses-9d2f2.web.app/traffic-light-simulator-3d.html)
- [BACKYARD DIG HOLE 3D SIMULATOR](https://quizverses.pages.dev/backyard-dig-hole-3d-simulator.html)
- [FASHIONISTA CHRISTMAS EVE PARTY](https://quizverses.pages.dev/fashionista-christmas-eve-party.html)
- [INDEX5](https://studyquesthub.web.app/index5.html)
- [THIEF STICK PUZZLE MAN ESCAPE](https://quizverses.github.io/thief-stick-puzzle-man-escape.html)
- [POTION SORT](https://quizverses.github.io/potion-sort.html)
- [OM NOM RUN](https://quizverses.pages.dev/om-nom-run.html)
- [SPORTSBALL MERGE](https://quizverses.github.io/sportsball-merge.html)
- [NUBIK IN THE MONSTER WORLD](https://quizverses.pages.dev/nubik-in-the-monster-world.html)
- [CUTE KITTY MERGE](https://quizverses.pages.dev/cute-kitty-merge.html)
- [WORMS ZONE](https://quizverses.pages.dev/worms-zone.html)
- [BLOCK MINE FUSE TNT](https://quizverses.github.io/block-mine-fuse-tnt.html)
- [SERIOUS HEAD 2](https://quizverses-9d2f2.web.app/serious-head-2.html)
- [CATEGORY CANNON22](https://quizverses.github.io/category-cannon22.html)
- [CATEGORY PREMIUM PERKS71](https://quizverses.github.io/category-premium-perks71.html)
- [CATEGORY EDUCATIONAL](https://quizverses-9d2f2.web.app/category-educational.html)
- [BLACK PINK BLACK FRIDAY FEVER](https://quizverses.pages.dev/black-pink-black-friday-fever.html)
- [WINTER WONDERLAND MAHJONG](https://studyquests.github.io/winter-wonderland-mahjong.html)
- [CATEGORY COLLECT565](https://quizverses.github.io/category-collect565.html)
- [HOBO SPEEDSTER](https://studyquests.github.io/hobo-speedster.html)
- [CATEGORY DRAGON22](https://quizverses.github.io/category-dragon22.html)
- [CATEGORY WEB PROXY](https://quizverses-9d2f2.web.app/category-web-proxy.html)
- [CATEGORY ADVENTURE 2](https://quizverses-9d2f2.web.app/category-adventure-2.html)
- [MERMAIDCORE AESTHETICS](https://quizverses.pages.dev/mermaidcore-aesthetics.html)
- [CATEGORY PUZZLE 5](https://quizverses-9d2f2.web.app/category-puzzle-5.html)
- [PIPE PUZZLE CONNECT FLOW](https://quizverses.github.io/pipe-puzzle-connect-flow.html)
- [CHRISTMAS SORTING](https://quizverses.pages.dev/christmas-sorting.html)
- [CATEGORY ROBOT49](https://quizverses.github.io/category-robot49.html)
- [FIX DA BRAINROT](https://quizverses.pages.dev/fix-da-brainrot.html)
- [BUBBLE SHOOTER POP](https://quizverses.pages.dev/bubble-shooter-pop.html)
- [CATEGORY THINKY](https://studyquesthub.web.app/category-thinky.html)
- [FAST BALL JUMP](https://studyquests.github.io/fast-ball-jump.html)
- [CATEGORY FPS174](https://studyquesthub.web.app/category-fps174.html)
- [IDLE MERGE CAR AND RACE](https://quizverses.pages.dev/idle-merge-car-and-race.html)
- [CATEGORY PLATFORM260](https://studyquesthub.web.app/category-platform260.html)
- [CATEGORY PUZZLE 4](https://quizverses-9d2f2.web.app/category-puzzle-4.html)
- [ASMR BEAUTY CLINIC](https://quizverses.github.io/asmr-beauty-clinic.html)
- [MONSTER SLAYERS](https://quizverses.github.io/monster-slayers.html)
- [FAMILY SQUID CHALLENGE](https://quizverses.github.io/family-squid-challenge.html)
- [BASKET SWAP](https://studyquests.github.io/basket-swap.html)
- [ARCHERY LEGENDS](https://quizverses.pages.dev/archery-legends.html)
- [NUMBER DOMINATION](https://quizverses.github.io/number-domination.html)
- [WILD WEST MATCH 2 THE GOLD RUSH](https://quizverses.pages.dev/wild-west-match-2-the-gold-rush.html)
- [CATEGORY ART](https://studyquests.github.io/category-art.html)
- [TINY GOLF KING](https://quizverses.github.io/tiny-golf-king.html)
- [CATEGORY TOWER DEFENSE 2](https://studyquesthub.web.app/category-tower-defense-2.html)
- [INDEX21](https://studyquesthub.web.app/index21.html)
- [IDLE BARBER SHOP](https://quizverses.pages.dev/idle-barber-shop.html)
- [BLOXORZ BLOCK PUZZLE 3D](https://quizverses.github.io/bloxorz-block-puzzle-3d.html)
- [COLOR BUMP DANCER](https://quizverses.github.io/color-bump-dancer.html)
- [CATEGORY BIKE](https://studyquests.github.io/category-bike.html)
- [CATEGORY SIMULATION 2](https://quizverses.github.io/category-simulation-2.html)
- [CATEGORY MAHJONG CONNECT](https://quizverses.pages.dev/category-mahjong-connect.html)
- [NUMBER COLLECTOR BRAINTEASER](https://quizverses.pages.dev/number-collector-brainteaser.html)
- [LABUBU COLORING ADVENTURE](https://quizverses-9d2f2.web.app/labubu-coloring-adventure.html)
- [CATEGORY 2D1 070](https://studyquests.github.io/category-2d1-070.html)
- [LITTLE DENTIST DASH](https://quizverses.pages.dev/little-dentist-dash.html)
- [TOKA BOKA HOME CLEAN UP DESIGN](https://studyquests.github.io/toka-boka-home-clean-up-design.html)
- [CATEGORY BATTLE523](https://studyquests.github.io/category-battle523.html)
- [CATEGORY PUZZLE 5](https://quizverses.github.io/category-puzzle-5.html)
- [CATEGORY FOOTBALL](https://quizverses.pages.dev/category-football.html)
- [LITTLE BUGS](https://quizverses.github.io/little-bugs.html)
- [PARKOUR WORLD 2](https://quizverses.github.io/parkour-world-2.html)
- [CATEGORY SPACE57](https://quizverses.github.io/category-space57.html)
- [MR LONG HAND](https://quizverses.github.io/mr-long-hand.html)
- [SOLITAIRE STORY TRIPEAKS 6](https://quizverses-9d2f2.web.app/solitaire-story-tripeaks-6.html)
- [TIMEWARRIORS](https://quizverses.github.io/timewarriors.html)
- [FOREST GLADE MYSTERIES](https://quizverses.github.io/forest-glade-mysteries.html)
- [CATEGORY CLASSIC97](https://quizverses.github.io/category-classic97.html)
- [CATEGORY 2D1 070](https://studyquesthub.web.app/category-2d1-070.html)
- [OBBY ESCAPE BARRYS JAIL PARKOUR](https://studyquests.github.io/obby-escape-barrys-jail-parkour.html)
- [STICKMAN TEAM DETROIT](https://studyquests.github.io/stickman-team-detroit.html)
- [CATEGORY TURN BASED30](https://quizverses.github.io/category-turn-based30.html)
- [STICKMAN SANTA](https://quizverses.github.io/stickman-santa.html)
- [CATEGORY THINKY 2](https://studyquesthub.web.app/category-thinky-2.html)
- [CATEGORY ANIMAL216](https://quizverses.pages.dev/category-animal216.html)
- [INDEX18](https://quizverses.pages.dev/index18.html)
- [BALING BUM](https://studyquests.github.io/baling-bum.html)
- [MINIGIANTS IO](https://quizverses.github.io/minigiants-io.html)
- [GLACIER RUSH](https://quizverses-9d2f2.web.app/glacier-rush.html)
- [RESCUE RIFT](https://studyquests.github.io/rescue-rift.html)
- [MATH BLOCK](https://studyquests.github.io/math-block.html)
- [INDEX33](https://studyquests.github.io/index33.html)
- [FLOWER BLOCK](https://quizverses.pages.dev/flower-block.html)
- [HEDGIES](https://quizverses.pages.dev/hedgies.html)
- [INDEX14](https://quizverses-9d2f2.web.app/index14.html)
- [CAR FIGHTER](https://quizverses.pages.dev/car-fighter.html)
- [BED WARS](https://quizverses.github.io/bed-wars.html)
- [SLITHERCRAFT IO](https://quizverses.pages.dev/slithercraft-io.html)
- [STICKER JAM PEEL OFF MATCH](https://quizverses.github.io/sticker-jam-peel-off-match.html)
- [BUBBLE SHOOTER VINTAGE](https://studyquests.github.io/bubble-shooter-vintage.html)
- [CATEGORY ADVENTURE 2](https://studyquests.github.io/category-adventure-2.html)
- [CATEGORY AGILITY 3](https://studyquesthub.web.app/category-agility-3.html)
- [CATEGORY CASUAL 3](https://studyquesthub.web.app/category-casual-3.html)
- [LAST PLAY RAGDOLL SANDBOX KQB](https://studyquests.github.io/last-play-ragdoll-sandbox-kqb.html)
- [CATEGORY 2048](https://quizverses.pages.dev/category-2048.html)
- [HERITAGE MAHJONG CLASSIC](https://studyquests.github.io/heritage-mahjong-classic.html)
- [CRAZY BUNNIES](https://quizverses.github.io/crazy-bunnies.html)
- [INDEX9](https://quizverses.pages.dev/index9.html)
- [ROBYBOX SPACE STATION WAREHOUSE](https://quizverses.github.io/robybox-space-station-warehouse.html)
- [COOL CARS RACING AT ALTITUDE](https://quizverses.pages.dev/cool-cars-racing-at-altitude.html)
- [TRAVEL WITH ME ASMR EDITION](https://quizverses.github.io/travel-with-me-asmr-edition.html)
- [CATEGORY INTERSTELLARPROXY](https://studyquests.github.io/category-interstellarproxy.html)
- [ADVERSATOR](https://quizverses.github.io/adversator.html)
- [CATEGORY TANK58](https://studyquests.github.io/category-tank58.html)
- [CATEGORY ADVENTURE 4](https://studyquests.github.io/category-adventure-4.html)
- [CATEGORY ANIMAL215](https://studyquesthub.web.app/category-animal215.html)
- [MEMEVOIO](https://quizverses.github.io/memevoio.html)
- [BOMBER BATTLE ARENA](https://quizverses.pages.dev/bomber-battle-arena.html)
- [COLOR SCREW RESCUE PUZZLE](https://quizverses.github.io/color-screw-rescue-puzzle.html)
- [CATEGORY MAKEUP51](https://studyquesthub.web.app/category-makeup51.html)
- [HIDDEN OBJECTS VACATION IN BRAZIL](https://quizverses-9d2f2.web.app/hidden-objects-vacation-in-brazil.html)
- [DELICIOUS EMILYS NEW BEGINNING VALENTINES EDITION](https://studyquests.github.io/delicious-emilys-new-beginning-valentines-edition.html)
- [POPPY PLAYTIME 3 GAME](https://quizverses.pages.dev/poppy-playtime-3-game.html)
- [K WEDDING DREAM](https://quizverses.github.io/k-wedding-dream.html)
- [TANK ATTACK 5](https://quizverses.github.io/tank-attack-5.html)
- [CUBE DROP PUZZLE](https://quizverses-9d2f2.web.app/cube-drop-puzzle.html)
- [TURRET GUNNER](https://quizverses.github.io/turret-gunner.html)
