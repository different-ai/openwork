# Installing OpenWork with OpenShell sandboxing

This is the install + first-run guide for the OpenShell-enabled fork of
OpenWork. If you're a banker following an IT-provided MSI, start at
**Step 1 — install**. If you're IT preparing a fleet deployment, jump to
**For IT: deployment notes** at the bottom.

---

## What you'll get

After install, every new agent session you start can run inside an
NVIDIA OpenShell sandbox — a Firecracker microVM with the policy your
firm picked. The agent has its own filesystem, no access to your laptop's
network outside the firm-allowlisted endpoints, and resource caps so a
runaway prompt can't take your laptop down.

You still get the same OpenWork chat UI; the sandbox is invisible until
something tries to do something the policy disallows, at which point
you'll see an approval prompt.

---

## Prerequisites

- Windows 11 (build 22000 or later)
- 16 GB RAM minimum
- 30 GB free disk space
- Admin rights for the **first launch only** (to install WSL2)
- BitLocker recovery key handy (you may be prompted after the first
  reboot — see **What if** below)

OpenWork ships everything else — the WSL2 distro, Docker Engine, the
OpenShell CLI, and the default banking policy bundle — all bundled in
the installer. No Microsoft Store. No corporate-proxy worries during
setup.

---

## Step 1 — install

1. Double-click the installer your IT delivered:
   `openwork-windows-x64-<version>.exe`
2. If Windows SmartScreen warns about an unrecognized publisher,
   ask IT — the signed build should pass. Don't bypass the warning on
   your own.
3. Accept the install location (defaults to `%LOCALAPPDATA%\OpenWork`).
4. Launch OpenWork. **Don't** close the window if it looks busy on
   first launch — see Step 2.

---

## Step 2 — first-run sandbox setup

The first time you launch, OpenWork detects that OpenShell isn't
installed yet and walks you through a one-time setup wizard.

The wizard runs **six steps**. Each one tells you what it's doing:

1. **Preflight** — checks Windows version, free disk, Hyper-V state.
   Instant.
2. **WSL2** — installs Windows Subsystem for Linux. **You'll see a UAC
   prompt here.** Click Yes. **Windows will then ask you to reboot.**
   Close OpenWork, reboot, and launch OpenWork again — the wizard
   resumes automatically. ~5 minutes including the reboot.
3. **Distro** — imports the Ubuntu image that comes bundled with the
   installer. ~2 minutes, no network needed.
4. **Docker** — installs Docker Engine inside the distro. ~3 minutes,
   no network needed (Docker packages are pre-baked into the image).
5. **OpenShell** — initializes the OpenShell CLI and starts the
   gateway pod. ~2 minutes.
6. **Verify** — runs the Doctor end-to-end. When all components are
   green, setup is done.

After Verify completes, **Settings → Sandbox** shows green for every
component and you're ready to create your first sandboxed workspace.

---

## What if

### "Your laptop is asking for a BitLocker recovery key after the reboot"

Windows sometimes requires re-authentication after Hyper-V is enabled.
Your IT department has the recovery key for your laptop.

**Don't guess.** Multiple wrong attempts can lock you out. Open a help-
desk ticket *before* clicking continue on the BitLocker screen if you
don't have the key.

### "Windows says virtualization isn't enabled"

Hyper-V depends on a BIOS setting (Intel VT-x or AMD-V). Your IT
department needs to flip it during a maintenance window — it requires
booting into firmware setup, which can't be done remotely.

Send IT a ticket with this text:

> Hi — I need virtualization (Intel VT-x or AMD-V) enabled in the BIOS
> on my laptop so I can run OpenWork's OpenShell sandbox. The
> "Virtual Machine Platform" Windows optional feature shows as Disabled
> (this is the WSL2 prerequisite, not the full Hyper-V role). Could we
> schedule a 10-minute maintenance window to enable it?

### "wsl --install fails with a policy error"

Your firm's group policy may block `wsl --install`. OpenWork's
installer surfaces the exact error message from Windows — copy that
text and email it to IT along with this:

> Hi — OpenWork failed to install WSL2 on my laptop:
>
>     <paste error here>
>
> Could we get the
> `Computer Configuration → Administrative Templates → Windows
> Components → Windows Subsystem for Linux` GPO updated to allow it?

### "EDR (CrowdStrike / SentinelOne) keeps killing the installer"

OpenWork spawns `wsl.exe` and `docker` repeatedly during setup. Some
EDR profiles treat repeated subprocess spawning as suspicious. Open the
Doctor (Settings → Sandbox → Refresh) and watch for "wsl.exe processes
are being terminated by another program" — if you see it, ask IT to
allowlist:

- `%LOCALAPPDATA%\OpenWork\OpenWork.exe`
- `%LOCALAPPDATA%\openwork\distro\ext4.vhdx`
- The `wsl.exe` parent process

### "First run says I'm out of disk space"

The installer needs ~10 GB free during setup; the steady-state
distro+sandbox usage is ~5 GB. Doctor checks `/` inside the distro for
free space and toasts you when you drop below 10%. If that happens:

1. Settings → Sandbox → Reset OpenShell distro (wipes + re-imports the
   bundled rootfs — preserves your workspaces in OpenWork's local
   storage, but loses any state inside the distro)
2. Run `wsl --shrink openwork-openshell` to compact the virtual disk

### "My session won't start — Doctor says gateway: missing"

Settings → Sandbox → **Restart gateway**. OpenWork probes the installed
OpenShell CLI for whichever start verb it exposes (the documented one
has shifted between releases), then falls back to restarting the
gateway container directly through Docker if the CLI doesn't expose a
start verb anymore.

If that still fails, the error toast includes the CLI version and the
exact commands that were attempted — paste both into a help-desk ticket.

---

## Claude Code (OpenEral) workspaces

OpenWork can run Claude Code or OpenClaw inside the same OpenShell
sandbox infrastructure, with a PostgreSQL-backed `/home/agent` that
restores across sessions and machines. Pick the **OpenEral — Claude
Code** profile when creating a workspace; the chat UI is replaced by
an embedded terminal where Claude Code's TUI runs.

What you need first:

- A reachable `DATABASE_URL` (Supabase, Neon, or firm-internal Postgres)
- An Anthropic API key (`sk-ant-...`)
- The OpenShell stack already installed (Settings → Sandbox → green)

Configure both credentials in **Settings → Sandbox → OpenEral
configuration**. Values are encrypted by the OS keyring and never sent
to the renderer once saved.

When you open a Claude Code workspace, the bootstrap takes ~30s on
first use (image pull + sandbox create) and ~3s thereafter (reconnect).
You'll see a three-step progress card during the bootstrap. Once
Claude Code's welcome banner appears, type normally.

Full walkthrough + troubleshooting: [`OPENERAL.md`](./OPENERAL.md).

---

## For IT: deployment notes

### Default policy

OpenWork ships **`banking-strict.yaml`** as the default policy. It:

- Allows egress only to `api.anthropic.com`, `api.openai.com`, and
  `REPLACE.*.internal.bank.invalid` placeholders you need to fill in
- Hard-denies SMB/SSH/NetBIOS ports + public DNS (1.1.1.1, 8.8.8.8,
  9.9.9.9)
- Limits each sandbox to 2 vCPU / 4 GB RAM / 10 GB disk
- Requires approval for any HTTP request to a non-allowlisted host

See `apps/orchestrator/policies/README.md` for the authoring guide and
the schema fields.

### Replacing placeholders

The shipped `banking-strict.yaml` has `REPLACE.*.internal.bank.invalid`
entries that need to be edited to point at your firm's internal hosts.
Two ways to ship the override:

1. **Per-laptop file drop:** copy your firm-specific YAML to
   `%LOCALAPPDATA%\openwork\openshell-policies\firm-strict.yaml` via
   SCCM/Intune. Then deliver a deployment profile that sets
   `defaultPolicy: firm-strict.yaml`.
2. **In-place edit:** modify the file shipped with the installer at
   `%LOCALAPPDATA%\OpenWork\resources\openshell-policies\banking-strict.yaml`.
   Less ideal — the next auto-update replaces it.

### Sandbox health Doctor

The Doctor is the single source of truth for "is OpenShell working?".
For triage, ask the user to:

1. Open Settings → Sandbox
2. Click Refresh (top right)
3. Screenshot the component checklist + paste the install activity log

The component IDs map 1:1 to the failure-mode table in the spec — IT
diagnostics teams already know what `docker: missing` vs.
`openshell-cli: warn` mean.

### Telemetry

OpenWork does not phone home about sandbox health by default. If you
need structured failure-mode reporting for your fleet, the Doctor's
output is JSON-serializable and can be picked up by your monitoring
agent from the IPC channel `openshellDoctor`. The plumbing for opt-in
fleet telemetry is a separate spec (intentionally — banker-product
telemetry has compliance requirements that vary firm to firm).
