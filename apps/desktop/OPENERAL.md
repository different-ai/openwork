# OpenWork × OpenEral

How to run **Claude Code** (or **OpenClaw**) inside an OpenEral sandbox,
embedded directly in an OpenWork workspace.

OpenEral (https://github.com/stringcost/openeral) is a pre-built
OpenShell sandbox image — `ghcr.io/sandys/openeral/sandbox:just-bash` —
that runs Claude Code as a foreground TTY process with a
PostgreSQL-backed `/home/agent`. OpenWork wraps the install, lifecycle,
and TTY plumbing so a banker can pick "Claude Code" as their agent and
have it just work.

---

## Prerequisites

- Windows 11 (build 22000 or later) with WSL2 enabled
- The OpenWork OpenShell installer has run successfully
  (Settings → Sandbox → all green)
- Docker Engine running inside the `openwork-openshell` distro
  (auto-installed by the installer)
- A reachable PostgreSQL connection string — Supabase, Neon, or any
  firm-internal Postgres reachable from inside the WSL distro
- An Anthropic API key (`sk-ant-...`)

---

## Step 1 — configure credentials

OpenEral needs two credentials at session start:

1. **`DATABASE_URL`** — a `postgresql://...` connection string. OpenEral
   creates the `_openeral` schema there on first run; the sandbox's
   `/home/agent` is persisted to that schema and restores across
   sessions and machines as long as you reuse the same workspace.

2. **`ANTHROPIC_API_KEY`** — only required for the **OpenClaw** profile.
   Claude Code can use the OpenShell provider system instead, but
   configuring the key here is fine for both.

Open **Settings → Sandbox**:

- Pick **OpenShell** as the sandbox backend
- Pick **OpenEral — Claude Code** as the launch profile
- The **OpenEral configuration** panel appears below
- Click **Configure** on each credential row, paste the value, click
  **Save**. Values are encrypted at rest via the OS keyring
  (Keychain / DPAPI / libsecret) and never leave the main process
  after they're saved
- Click **Test** next to `DATABASE_URL` to verify reachability. A
  transient `postgres:16-alpine` container runs `psql -tAc "select 1"`;
  green if it succeeds

---

## Step 2 — create a workspace

**Workspaces → Create local**:

- The sandbox backend defaults to OpenShell (matching your Settings
  pick)
- The launch profile sub-selector defaults to OpenEral — Claude Code
- Click **Create**

The workspace is created locally. The first time you open it, OpenWork
materializes the sandbox.

---

## Step 3 — open the workspace

Click the workspace in the sidebar. Instead of OpenWork's chat UI, the
session pane shows an embedded terminal with a three-step bootstrap
indicator:

1. **Pulling image + creating sandbox** — `docker pull
   ghcr.io/sandys/openeral/sandbox:just-bash` (lazy, only on first use
   per WSL distro) and `openshell sandbox create --from <image>
   --upload <credentials>:/sandbox/openeral-input --provider claude
   --auto-providers --detach -- openeral`
2. **Mounting terminal** — xterm.js initializes
3. **Opening PTY** — `wsl.exe -d openwork-openshell -- openshell
   sandbox connect <name>` runs inside a real PTY (node-pty)

When all three steps complete (green dots), Claude Code's welcome
banner appears. Type to interact normally.

---

## Step 4 — verify persistence

The Postgres-backed `/home/agent` is OpenEral's headline feature. To
see it work:

```text
You ▸ Create a file called founder-demo.md with the text "hello from openwork"
Claude ▸ <creates the file>
```

Close the workspace tab. Reopen it — the bootstrap reconnects to the
**existing** sandbox (the toolbar shows "Reconnecting to <name>"). Ask:

```text
You ▸ What's in founder-demo.md?
Claude ▸ hello from openwork
```

The Postgres `_openeral.workspace_files` table holds the file. Same
workspace ID + same `DATABASE_URL` on a different laptop = same
restored home directory.

---

## Toolbar reference

The thin bar above the terminal shows the sandbox status and three
actions:

- **Pop out** — opens the same sandbox in a separate Windows Terminal
  window. Both connections share the same shell history (OpenEral
  `openeral-bash` daemon multiplexes via Unix socket). Useful for
  power users who want Windows Terminal's full features (tabs,
  splits, copy/paste shortcuts).
- **Delete sandbox** — tears the sandbox container down. The
  Postgres-backed `/home/agent` files persist; reopening the workspace
  creates a fresh sandbox that restores them.
- **Reconnect** — appears when the PTY disconnects unexpectedly
  (closed Windows Terminal pop-out, EDR killed the process, etc.).
  Tears down the old PTY and opens a fresh one against the same
  sandbox.

---

## Claude Code vs OpenClaw

| | Claude Code (default) | OpenClaw |
|---|---|---|
| Profile | `openeral-claude` | `openeral-openclaw` |
| Image | `ghcr.io/sandys/openeral/sandbox:just-bash` | `ghcr.io/pavitra-programmers/openeral/sandbox:just-bash` |
| API key delivery | OpenShell provider system or uploaded file | Uploaded file only (OpenClaw's embedded gateway can't resolve provider placeholders) |
| StringCost cost tracking | Supported via `STRINGCOST_API_KEY` | Not supported — OpenClaw talks to Anthropic directly |
| First-run latency | ~30s (image pull + sandbox create) | ~3 min (additional npm-package staging — pre-baked in newer images) |

Pick at workspace-create time. The profile is fixed for the workspace's
lifetime — switch by creating a new workspace.

---

## Troubleshooting

### "DATABASE_URL is not configured"

Open Settings → Sandbox → OpenEral configuration. Set DATABASE_URL.

### "ANTHROPIC_API_KEY is required for OpenClaw"

Same — set the second credential. Claude profile doesn't need this.

### "OpenShell is not ready"

The WSL distro, Docker, OpenShell CLI, or gateway is missing or
unhealthy. Settings → Sandbox → Doctor panel surfaces the failing
component.

### "Could not reach PostgreSQL"

Most common causes:

- `host.docker.internal` not reachable from inside the WSL distro on
  certain Windows network configs. Use an external Postgres (Supabase,
  Neon) or the firm-internal one.
- Wrong password or URL shape — verify by running `psql "$DATABASE_URL"
  -c "select 1"` outside OpenWork first
- Firm firewall blocks the Postgres port (5432 / 6543) — escalate to IT

### Pop-out terminal won't open

OpenWork tries Windows Terminal (`wt.exe`) first, falls back to
`cmd.exe`. If both fail, your firm's GPO may block UAC-elevated
processes. Use the embedded terminal — it works without the pop-out.

### Session disconnects mid-task

Click **Reconnect**. The sandbox stays alive across the PTY drop; only
the wsl.exe child died. Common causes:

- EDR (CrowdStrike / SentinelOne) killed wsl.exe — escalate to IT for
  an allowlist entry on `%LOCALAPPDATA%\OpenWork\OpenWork.exe`
- Laptop went to sleep — Windows can reset WSL2's utility VM. Hyper-V
  power settings can mitigate

### "Files disappear after sandbox delete"

That means DATABASE_URL wasn't actually configured or Postgres
persistence didn't kick in. Check the Postgres `_openeral` schema —
should have a `workspace_files` row for each path. If empty, the
sandbox ran in OpenEral's local-only mode (rare; usually a sign that
the credential file didn't get uploaded correctly).

---

## Architecture (for IT)

```
┌─────────────────────────────────────────────────────────────┐
│  OpenWork (Electron desktop app)                            │
│  Renderer: xterm.js full-pane session view                  │
│  Main process: node-pty bridge + Electron IPC               │
└─────────────────────────────────────────────────────────────┘
                       │
                       │ IPC: openeral:pty-data / openeral:pty-exit
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  main.mjs                                                   │
│  - openeralCredentials  (safeStorage-encrypted DATABASE_URL │
│                          / ANTHROPIC_API_KEY)               │
│  - openeral.createOpenEralSandbox  (image pull, provider    │
│                                     create, --upload)       │
│  - openeral-pty.openSession  (node-pty.spawn → wsl.exe)     │
└─────────────────────────────────────────────────────────────┘
                       │
                       │ wsl.exe -d openwork-openshell
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  WSL2 distro: openwork-openshell                            │
│  - Ubuntu 24.04 + Docker Engine + OpenShell CLI             │
│  - openshell sandbox create --from ghcr.io/sandys/...       │
│                              --upload .../sandbox/openeral-input│
│                              --provider claude --auto-providers │
│                              --detach -- openeral           │
└─────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  OpenEral sandbox container (privileged)                    │
│  - setup.sh reads /sandbox/openeral-input/db-url + key      │
│  - Runs DB migrations against the _openeral schema          │
│  - Restores /home/agent from Postgres                       │
│  - Starts openeral-bash daemon (Unix socket on /tmp/...)    │
│  - exec claude (or openclaw)                                │
└─────────────────────────────────────────────────────────────┘
```

Credentials never reach the renderer once saved. They flow renderer →
IPC → main → `safeStorage.encryptString` → JSON file at
`~/.openwork/openeral-credentials.json` (mode 0o600). When a sandbox is
created, `openeral.mjs` decrypts the values, writes them to a temp
directory at `os.tmpdir()/openeral-input-<random>/`, passes the
directory via `--upload`, and cleans the temp dir in a `finally` block.

Once inside the sandbox, OpenEral's `setup.sh` reads the files from
`/sandbox/openeral-input/` and uses them to bootstrap the agent.

For deeper details on OpenEral itself (StringCost integration, custom
images, the openeral-bash daemon's protocol), see the upstream README
at https://github.com/stringcost/openeral.
