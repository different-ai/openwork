# openwork

The `openwork` command signs you in to OpenWork Cloud and administers an
organization from a terminal, a script, or an agent.

```bash
openwork auth login                      # sign in from the browser with a one-time code
openwork auth whoami
openwork org list
openwork members list
openwork members set-role sam@example.com --role admin
openwork invitations create kim@example.com
```

Every command is `openwork <resource> <verb>`. Run `openwork --help` for the
full list, or `openwork help config` for one group.

## Signing in

`openwork auth login` prints a link and a one-time code, and waits while you
approve it in the browser. No password reaches the command. The sign-in is
saved as a profile in `~/.openwork/profiles.json`, readable only by you.

Profiles let you keep several sign-ins, for example one per organization or
one for a self-hosted OpenWork:

```bash
openwork auth login --profile work --base-url https://openwork.example.com
openwork auth list
openwork auth switch work
```

Credentials are chosen in this order:

1. `OPENWORK_API_KEY`, an organization API key. Use this in scripts and CI.
2. `OPENWORK_API_TOKEN`, a session token.
3. `--profile`, then `OPENWORK_PROFILE`, then the profile you last switched to.
4. A sign-in made with `openwork-bootstrap login`.

While one of the two variables is set, `auth login` and `auth logout` refuse to
run, because the variable would still win.

## Choosing the organization

A profile remembers the organization you picked while signing in. Change it
with `openwork org use <id-or-slug>`, or override it for one command with
`--org <id-or-slug>` or `OPENWORK_ORG_ID`. A command stops before changing
anything when you are not a member of the organization you named. An API key
works only in the organization it was created in.

## Output

Results go to stdout; prompts, progress and errors go to stderr.

- At a terminal you get readable text and tables.
- When output is piped, or with `--json`, you get JSON. Errors are JSON too:
  `{"error": "<code>", "message": "..."}`.
- The exit code is 0 on success and 1 on any failure.

## Changes

- `--dry-run` prints the request a command would send instead of sending it.
- Removing a member and cancelling an invitation ask first. `--force` skips the
  question. With no one at the terminal they stop unless you pass `--force`.
- Changing roles, removing members and managing invitations need a recent
  sign-in. At a terminal the command asks you to confirm in the browser and
  then finishes the change. In a script it stops and tells you to run
  `openwork auth login --force`. API keys are exempt.

## Configuration as a file

An organization's configuration (teams, roles, connectors, AI providers,
policies and more) can be kept as one JSON file, reviewed in git, and deployed.

```bash
openwork config pull --out org-config.json    # download it
openwork config diff org-config.json          # what importing it would change
openwork config push org-config.json          # upload it for review
openwork config deploy org-config.json        # upload, confirm, apply and wait
```

- **Nothing is written by an upload.** Every import is a change request with a
  plan: what would be created, updated, renamed or deleted. `config diff` shows
  the plan without storing anything.
- **`config deploy`** shows the uploaded request's plan, asks you to confirm,
  applies it and waits for the result. It exits with 1 when an item fails, and
  says where it stopped. When the organization already matches the file it does
  nothing. Declining withdraws the request.
- **Decisions.** When items need an answer (a secret to enter, an item to match),
  `deploy` stops and leaves the request open. Answer them in the dashboard under
  Settings › Config, then run `openwork config deploy --request <id>`. Answers
  from an earlier import of the same source are reused by an upload, but not by
  `config diff`, so a diff can show more open questions than a deploy.
- **Modes.** `--mode merge` (the default) creates and updates. `--mode mirror`
  can also delete what the file leaves out; each delete is chosen in the
  dashboard.
- **Secrets** are never in the file. Each is a placeholder.
- **Second approver.** If the organization requires one, `deploy` records your
  approval and stops; the request stays open for the other person.
- `config requests`, `config status <id>` and `config cancel <id>` list, show and
  withdraw change requests. `config areas` lists what you may export or import.

In CI, set `OPENWORK_API_KEY` to a **config token** (an API key of type Config,
from Settings › API keys). It needs `config:export` to pull, `config:submit` to
diff and push, and both `config:submit` and `config:apply` to deploy a file. A
config token only works with `openwork config`; a standard API key only works
with the other commands. Never give the token to a job a pull request can change.

The file format, areas and rules are described in
[Export and import organization configuration](../docs/self-host/export-import-configuration.mdx).

## Development

Node runs the TypeScript sources directly, so there is no build step.

```bash
node packages/cli/bin/openwork.mjs --help
pnpm --filter @openwork/cli test
pnpm --filter @openwork/cli typecheck
```
