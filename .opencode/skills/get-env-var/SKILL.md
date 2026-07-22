---
name: get-env-var
description: "get an env var, fetch a secret, missing env var, missing token/API key, load secrets from Infisical, infisical. Fetch secrets from the team's Infisical workspace into the shell environment so subsequent commands can use them."
---

# Skill: get-env-var

Fetch a secret from the team's Infisical workspace into the current shell so the next command can use it.

## When to use

- A command or script needs an env var that is not set, such as `BLOB_READ_WRITE_TOKEN`.
- A token, API key, or other secret is missing from the environment.
- The user asks to load secrets from Infisical.

## Setup (once per machine)

- Install the CLI on macOS: `brew install infisical/get-cli/infisical`.
- Check auth with `infisical user get`; if it fails, run `infisical login` and complete the browser flow.
- For CI or other non-interactive runs, set `INFISICAL_TOKEN` from a machine identity; the CLI skips login when it is present.
- This repo is already project-linked via tracked `.infisical.json` (`workspaceId: "e9f4542a-8714-46c3-a8fd-99d8cb370aeb"`, empty `defaultEnvironment`). From the repo root, `infisical` defaults to the `dev` environment slug when `--env` is omitted.

## Fetch one secret into the environment

Run from the repo root:

```bash
export NAME="$(infisical secrets get NAME --plain --silent)"
```

- Replace `NAME` with the secret name.
- Add `--env <slug>` for a non-default environment; this repo defaults to `dev`.
- Add `--path /some/folder` when secrets are organized in folders.

## Inject everything into a command

Run the command through Infisical so all project secrets are available only to that process:

```bash
infisical run -- <command>
```

## Rules

- Never echo, print, or otherwise log secret values.
- Never write secrets to files, logs, commit messages, PR bodies, or comments.
- Only use `--plain` inside command substitution, as in `export NAME="$(...)"`.
- If a secret does not exist, STOP and tell the user exactly which secret name and environment to add in Infisical; do not invent values.
