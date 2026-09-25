# Tenki OpenWork TypeScript Example

Small standalone TypeScript example that boots the headless OpenWork server inside a [Tenki Cloud](https://tenki.cloud) sandbox with the [`@tenkicloud/sandbox`](https://www.npmjs.com/package/@tenkicloud/sandbox) SDK, exposes it on a public preview URL, verifies `/health`, checks that `/workspaces` is `401` without a token and `200` with the client token, creates an OpenCode session through `/w/:workspaceId/opencode/session` and reads it back, prints startup timings, then terminates the sandbox.

Unlike the [microsandbox example](../microsandbox-openwork-rust), no local Docker image build is required: the sandbox installs the published [`openwork-server`](https://www.npmjs.com/package/openwork-server) npm package (which ships a compiled Linux binary) and downloads the OpenCode release pinned in the repo-root `constants.json`.

## Run

```bash
cd examples/tenki-openwork-ts
pnpm install --ignore-workspace
TENKI_API_KEY=tk_your_api_key pnpm start
```

`--ignore-workspace` keeps the install local to this directory; the example is intentionally not part of the repo's pnpm workspace, mirroring the standalone Rust example.

Requires Node.js 20+ and a Tenki API key from [tenki.cloud](https://tenki.cloud). The sandbox is ephemeral: it is terminated when the run finishes, fails, or is interrupted with `Ctrl+C`, and carries `maxDurationMs` / `idleTimeoutMinutes` backstops in case the process is killed outright.

To keep the sandbox running and connect the OpenWork desktop app (`Add a worker` -> `Connect remote`) to the printed URL and client token:

```bash
TENKI_API_KEY=tk_your_api_key OPENWORK_TENKI_KEEP_ALIVE=1 pnpm start
```

Useful environment overrides:

- `OPENWORK_SERVER_VERSION` - `openwork-server` npm version to install. Defaults to `latest`.
- `OPENCODE_VERSION` - OpenCode release tag to download (for example `v1.17.11`). Defaults to the `opencodeVersion` pin in the repo-root `constants.json`.
- `OPENWORK_PORT` - port the server listens on inside the sandbox. Defaults to `8787`.
- `OPENWORK_TOKEN` - remote-connect client token. Defaults to a random UUID; the preview URL is publicly reachable, so keep this secret.
- `OPENWORK_HOST_TOKEN` - host/admin token. Defaults to a random UUID.
- `OPENWORK_TENKI_KEEP_ALIVE` - set to `1` to keep the sandbox alive until `Ctrl+C` instead of terminating after the checks.
- `TENKI_PREVIEW_SLUG` - optional stable slug for the preview URL.
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` - forwarded into the server environment when set, so the managed OpenCode engine can run prompts.

Security note: the server runs with `OPENWORK_APPROVAL_MODE=auto`, so anyone holding the client token gets auto-approved command execution inside the sandbox - including use of any forwarded provider keys. The preview URL is publicly reachable; treat the printed tokens as secrets (for example, don't run this in CI where stdout is a public log).

## Typecheck

```bash
pnpm typecheck
```
