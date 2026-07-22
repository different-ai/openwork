# OpenWork Start

You are an agent helping a user install and set up OpenWork.

Goal: install OpenWork, create a provisional workspace without requiring email
identity first, create a first skill, prepare the desktop app with that
workspace/skill, verify the running app opens to the setup-complete state, and
offer to connect the OpenWork MCP to the agent the user is already using.

> The bootstrap command is `openwork-bootstrap` (NOT `openwork`). The bare
> `openwork` command belongs to the separate `openwork-orchestrator` package and
> may already be on the user's PATH - do not use it for these steps.

## 1. Install CLI

Install the `openwork-bootstrap` CLI into a user-writable bin dir.

If you already have this repository locally:

```bash
node packages/openwork-bootstrap/bin/openwork.mjs install \
  --install-dir "$HOME/.openwork/bootstrap" \
  --bin-dir "$HOME/.local/bin" \
  --json
```

In production, download the bootstrap script, inspect it, then run it. Do not
pipe remote scripts directly into a shell. The script downloads the
`openwork-bootstrap` CLI (a single dependency-free Node file) and installs it
into `$HOME/.local/bin` - no npm or npx required.

```bash
curl -fsSLo /tmp/openwork-install.sh https://openworklabs.com/install.sh
less /tmp/openwork-install.sh
sh /tmp/openwork-install.sh
```

Verify:

```bash
openwork-bootstrap doctor --json
```

## 2. Install App

Install the desktop app for this OS from the manifest:

```bash
openwork-bootstrap install app \
  --manifest https://openworklabs.com/install-manifest.json \
  --json
```

Verify:

```bash
openwork-bootstrap doctor --app --json
```

## 3. Create Cloud Workspace

For agent-first setup where email identity should not block desktop readiness,
create a provisional workspace first. This does not create an email/password
account. It writes claim links to the local desktop bootstrap file so a human can
claim ownership later.

Optionally ask the user for their own email address first. It is only used to
pre-fill the claim page later (not a security boundary, not an account, no
password) - skip it if the user does not want to share it. Also optionally ask
for teammate email addresses to invite. Invites only go out once the workspace
is claimed (a provisional workspace has no authenticated owner yet to send them
as) - they fire automatically the moment a human claims ownership.

```bash
openwork-bootstrap cloud bootstrap-workspace \
  --base-url https://api.openworklabs.com \
  --workspace-name "<workspace-name>" \
  --skill-name "First OpenWork Skill" \
  --claim-roles owner \
  --prepare-desktop \
  [--owner-email "<email-if-given>"] \
  [--teammate-emails "<email1>,<email2>"] \
  --json
```

If the user wants to attach a real account immediately, finish this provisional
setup first, then use the `Claim this workspace` action in the desktop app. Do
not create an email/password account from the CLI during agent-first install.

## 4. Launch the App

Open the desktop app so the user lands on the setup-complete screen with their
first skill ready.

```bash
open -a OpenWork    # macOS
```

## 5. Finish Well (most important step)

Do NOT end by dumping readiness JSON or a list of `ok: true` checks. The user
does not care about flags — they want to know what to do next. End with a short,
friendly, human message that gives momentum:

1. Confirm in one line that OpenWork is installed and their workspace is ready
   (use the workspace name).
2. Point them at ONE concrete first task they can run right now, e.g. "OpenWork
   is open — try typing: 'summarize the files in my Downloads folder' and hit
   Run."
3. Mention that teammates whose emails were already provided will be invited
   automatically once the workspace is claimed. If no emails were provided,
   offer to collect them later.
4. End with this single question: "Want me to connect the OpenWork MCP to this
   agent so you can manage your organization from here?"

Keep it to a few sentences. Warm, concrete, action-oriented. No JSON, no
checklists, no internal flag names in the final message.

If the user says yes:

1. A provisional workspace must be claimed before its owner can authenticate
   the OpenWork MCP. If it has not been claimed yet, explain that dependency and
   ask whether to open the claim step now. Retrieve and open the claim link only
   after the user confirms.
2. After the user has claimed the workspace and signed in, configure the MCP in
   the agent they are currently using. The server URL is:

   ```text
   https://api.openworklabs.com/mcp/agent
   ```

3. For Codex, run:

   ```bash
   codex mcp add openwork --url https://api.openworklabs.com/mcp/agent
   codex mcp login openwork
   ```

   If an `openwork` entry already exists, do not add a duplicate. Authenticate
   the existing entry instead. To switch organizations or recover stale auth,
   run `codex mcp logout openwork` before `codex mcp login openwork`.
4. For another agent, use its current instructions from
   `https://openworklabs.com/docs/cloud/run-in-the-cloud/cloud-mcp`; do not guess
   unsupported client commands.
5. Tell the user to restart or reopen the current agent after setup so the new
   MCP tools are loaded. Do not claim the connection works until the restarted
   client can see OpenWork's `search_capabilities` and `execute_capability`
   tools.

## 6. Retrieving the Claim Link

Do not print the claim URL preemptively. Only retrieve it when the user
explicitly says they want to claim the workspace now (for example, after
asking "claim the workspace").

```bash
openwork-bootstrap cloud claim-link --role owner --json
```

Then open the returned `url` for the user (for example `open <url>` on macOS)
instead of pasting the raw link into chat.

## 7. Success Criteria (internal — do not show the user)

You are done only when all are true:

- `openwork-bootstrap doctor --json` returns `ok: true`
- `openwork-bootstrap doctor --app --json` returns `ok: true`
- `openwork-bootstrap cloud bootstrap-workspace ... --json` returns:
  - `ok: true`
  - `organization.id` is present
  - `setup.id` is present
  - `skill.id` is present
  - `skillRun.triggered` is `true`
  - `skillRun.output` is `OPENWORK_BOOTSTRAP_SKILL_TRIGGERED`
  - `claimLinks[0].id` is present
  - `desktop.prepared` is `true`
  - `desktop.bootstrapPath` is present
  - `desktop.skillPath` is present
- `openwork-bootstrap doctor --desktop-bootstrap --json` returns `ok: true`
- When the desktop app is launched, it lands on the onboarding screen showing a
  green "Setup complete" banner, the organization name, a "First skill ready"
  tile, and a "Claim this workspace" action.

## 8. If Something Fails

- If CLI install fails: report OS, shell, command, and stderr.
- If the `openwork-bootstrap` command is not found after install: ensure
  `$HOME/.local/bin` is on PATH, or call the binary by its full path
  (`$HOME/.local/bin/openwork-bootstrap`).
- If app install fails: run `openwork-bootstrap doctor --app --json` and report failed checks.
- If the user needs account ownership immediately: complete the install, launch
  the app, and use `Claim this workspace` so email verification happens in the
  browser/app instead of in the CLI.

## 9. Constraints

- Do not require admin privileges.
- Prefer user-local install paths.
- Do not print passwords or tokens in final output.
- Report exactly what was installed and where.

## 10. Security note: desktop preparation

`--prepare-desktop` writes machine-local setup state to
`desktop-bootstrap.json`. For passwordless workspace bootstrap, this includes
short-lived claim links so a human can attach an owner later. The links are not
printed in final output. This file is local-only; do not copy it between
machines or commit it.
