# Contributing

- Review `AGENTS.md` and `MOTIVATIONS-PHILOSOPHY.md` to understand the product goals before making changes.
- Ensure Node.js, `pnpm`, the Rust toolchain, and `opencode` are installed before working inside the repo.
- Run `pnpm install` once per checkout, then verify your change with `pnpm typecheck` plus `pnpm test:e2e` (or the targeted subset of scripts) before opening a PR.
- Add new PRDs to `packages/app/pr/<name>.md` following the `.opencode/skill/prd-conventions/SKILL.md` conventions described in `AGENTS.md`.
