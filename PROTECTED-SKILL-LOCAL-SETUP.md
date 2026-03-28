# Protected Skill Local Setup

This note records the local setup and end-to-end checks needed for the protected skill flow.

## Why Rust/Cargo is needed

- The desktop app is a Tauri app with a Rust backend layer.
- Repo references:
  - [apps/desktop/package.json](/Users/charlie/github.com/cowork-zeng-law-group-wt-h1b-protected-skill/apps/desktop/package.json)
  - [apps/desktop/src-tauri/Cargo.toml](/Users/charlie/github.com/cowork-zeng-law-group-wt-h1b-protected-skill/apps/desktop/src-tauri/Cargo.toml)
- The local command I could not run earlier was:
  - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
- Without Rust/Cargo, Tauri desktop changes cannot be compiled or verified.

## Why Bun is needed

- The server package uses Bun to build the compiled `openwork-server` binary.
- Repo reference:
  - [apps/server/package.json](/Users/charlie/github.com/cowork-zeng-law-group-wt-h1b-protected-skill/apps/server/package.json)
- Relevant script:
  - `build:bin`: `bun build --compile src/cli.ts --outfile dist/bin/openwork-server`
- Without Bun, `openwork-server` binary builds cannot be completed locally.

## macOS install steps

These commands follow the current official setup guidance for Tauri prerequisites, Rust/rustup, and Bun.

### 1. Install macOS build prerequisites

For desktop-only Tauri development on macOS:

```bash
xcode-select --install
```

After installation, reopen Terminal.

### 2. Install Rust and Cargo

```bash
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
source "$HOME/.cargo/env"
rustc --version
cargo --version
```

If `cargo` is still not found after installation, close and reopen Terminal, then run:

```bash
source "$HOME/.cargo/env"
```

### 3. Install Bun

```bash
curl -fsSL https://bun.com/install | bash
source "$HOME/.zshrc"
bun --version
```

If `bun` is still not found, add this to `~/.zshrc`:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

Then reload:

```bash
source "$HOME/.zshrc"
bun --version
```

### 4. Install repo dependencies with the pinned pnpm version

```bash
npx pnpm@10.27.0 install --frozen-lockfile
```

## End-to-end gate for this protected skill

Run these from the repo root:

```bash
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
npx pnpm@10.27.0 --filter openwork-server build:bin
packaging/docker/dev-up.sh
```

Then do the UI verification:

1. Launch OpenWork locally.
2. Open the skills page.
3. Confirm `h1b-employee-docs-review` appears as a protected skill.
4. Confirm the skill cannot be opened, edited, shared, or deleted from the skills manager.
5. Open a chat and type `/`.
6. Confirm `h1b-employee-docs-review` appears in the slash picker.
7. Run `/h1b-employee-docs-review`.
8. Confirm the skill executes without exposing its internal prompt/body in the UI.
9. Capture screenshots if needed.

## Protected skill update reminder

Source skill folder:

- `/Users/charlie/Downloads/skill-file-h1b-employee-docs-review`

Current placeholder files:

- [/Users/charlie/Downloads/skill-file-h1b-employee-docs-review/references/review-guidelines.md](/Users/charlie/Downloads/skill-file-h1b-employee-docs-review/references/review-guidelines.md)
- [/Users/charlie/Downloads/skill-file-h1b-employee-docs-review/references/checklist.md](/Users/charlie/Downloads/skill-file-h1b-employee-docs-review/references/checklist.md)

After updating the source files, repack the encrypted bundle:

```bash
pnpm protected-skill:pack -- --name h1b-employee-docs-review --source /Users/charlie/Downloads/skill-file-h1b-employee-docs-review --output .openwork/protected-skills/h1b-employee-docs-review.bundle.json
```

The pack command now also updates `.openwork/protected-skills/manifest.json` with:

- `bundlePath`
- `version`
- `publishedAt`
- `checksum`

If the manifest does not already contain an entry for a new protected skill, provide initial metadata once:

```bash
pnpm protected-skill:pack -- --name your-skill-name --source /absolute/source/folder --output .openwork/protected-skills/your-skill-name.bundle.json --description "Short bilingual metadata-only description" --trigger "How staff should invoke the skill"
```

The packer ignores `.DS_Store` so macOS finder metadata is not bundled into the encrypted skill package.

Protected skill key file currently used on this machine:

```bash
~/.config/openwork/protected-skills.key
```

Any machine that needs to run protected repo skills must have the same key file provisioned out of band.

## What was already verified

Installed on this machine:

```bash
rustup 1.29.0
cargo 1.94.0
rustc 1.94.0
bun 1.3.11
```

These commands already passed in this worktree:

```bash
npx pnpm@10.27.0 install --frozen-lockfile
npx pnpm@10.27.0 --filter @openwork/app typecheck
npx pnpm@10.27.0 --filter @openwork/app build
npx pnpm@10.27.0 --filter openwork-server typecheck
npx pnpm@10.27.0 --filter openwork-server build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
npx pnpm@10.27.0 --filter openwork-server build:bin
packaging/docker/dev-up.sh
curl -sf http://localhost:<OPENWORK_PORT>/health
curl -sf http://localhost:<SHARE_PORT>/api/health
curl -sf http://localhost:<WEB_PORT>
```

## Docker dev stack fix

The original Docker startup problem had two causes:

```bash
1. pnpm used /app/.pnpm-store inside the bind-mounted repo
2. orchestrator and share both ran pnpm install concurrently against the same /app/node_modules tree
```

Fix applied in [packaging/docker/docker-compose.dev.yml](/Users/charlie/github.com/cowork-zeng-law-group-wt-h1b-protected-skill/packaging/docker/docker-compose.dev.yml):

```bash
1. mount the pnpm store as a named Docker volume at /app/.pnpm-store
2. use a shared lock/stamp so dependency installation happens once
```

After that change, `packaging/docker/dev-up.sh` completed successfully and brought up the web UI, server, and share service.
