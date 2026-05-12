# Release engineering: OpenShell-enabled OpenWork

Companion to the upstream `RELEASE.md`. Documents the additions this
fork makes to the release pipeline. Read upstream first for the
publish-to-GitHub-releases machinery; this file covers only the pieces
OpenShell adds on top.

---

## The two-workflow split

```
                ┌─────────────────────────────────────┐
   git tag v* ─►│ .github/workflows/                  │
                │   build-windows-openshell.yml       │
                │                                     │
                │   ┌─────────────┐                   │
                │   │ build-rootfs│ ubuntu-latest     │
                │   │  (~5 min)   │ Docker → tarball  │
                │   └─────┬───────┘                   │
                │         │ artifact: openshell-rootfs│
                │   ┌─────▼───────┐                   │
                │   │ build-app   │ windows-2022      │
                │   │  (~10 min)  │ pnpm + electron-  │
                │   │             │   builder         │
                │   └─────┬───────┘                   │
                └─────────┼───────────────────────────┘
                          │ artifact: openwork-windows-msi
                          │ (unsigned .exe)
                ┌─────────▼───────────────────────────┐
                │ .github/workflows/                  │
                │   sign-windows-openshell.yml        │
                │                                     │
                │   self-hosted runner labeled        │
                │   "signing" with HSM access         │
                │   signs via signtool                │
                └─────────┬───────────────────────────┘
                          │ artifact: openwork-windows-msi-signed
                          ▼
                  upload to GitHub Release
                  electron-updater clients pick this up
```

Two workflows on purpose: building can happen on cloud GHA runners
(fast, cheap), but signing needs the firm's HSM (self-hosted,
firm-network-only).

---

## What each workflow produces

### `build-windows-openshell.yml`

Trigger: `push` to `v*` tags, or manual `workflow_dispatch`.

Outputs:
- `openshell-rootfs` — `ubuntu-24.04-openshell.tar.gz` (~150 MB).
  Workflow-artifact, 7-day retention.
- `openwork-windows-msi` — unsigned `*.exe` from `electron-builder`.
  Workflow-artifact, default 90-day retention.

### `sign-windows-openshell.yml`

Trigger: completion of `build-windows-openshell.yml`, or manual
dispatch with a `build_run_id` input.

Outputs:
- `openwork-windows-msi-signed` — same installer, signed.
  Workflow-artifact, 90-day retention. **Skeleton state**: the signing
  step is a no-op until firm IT wires in their `signtool` invocation
  (see workflow file for the three common shapes — PFX file, KSP/HSM,
  Azure Key Vault).

To publish to a GitHub Release, uncomment the `softprops/action-gh-release`
step at the bottom of the signing workflow.

---

## Bumping the OpenShell CLI version

The CLI is pulled from NVIDIA's `main` branch installer at rootfs build
time:

```dockerfile
# apps/desktop/scripts/openshell-rootfs.Dockerfile
RUN curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell-Community/main/install.sh | bash
```

To pin to a specific OpenShell release:

1. Find the tag on the OpenShell-Community repo (e.g., `v0.42.0`)
2. Update the curl URL to use that tag:
   `.../OpenShell-Community/v0.42.0/install.sh`
3. Cut a v* tag on our repo — the build picks up the new pin

**Decision**: pin per release (predictability > freshness for banking).
Don't let WSL distros auto-update OpenShell on the banker side. If a
critical security fix needs to ship, cut a new OpenWork release.

---

## Bumping the Ubuntu base

The rootfs is built `FROM ubuntu:24.04`. Canonical's noble track is
the LTS we're committing to through 2029. If we ever need to move:

1. Update the FROM line in `apps/desktop/scripts/openshell-rootfs.Dockerfile`
2. Update the codename in the Docker apt sourcing line (currently
   `noble`)
3. Update `DISTRO_NAME` references? No — the WSL distro name
   (`openwork-openshell`) is independent of the underlying Ubuntu
   version, but the bundled `.tar.gz` filename should be renamed to
   match the new Ubuntu version
4. Update `apps/desktop/electron-builder.yml`'s win.extraResources
   filter if the filename pattern changes
5. Update `installer.mjs` `phaseDistro`'s WSL import call if the
   distro install path needs to change

---

## How `electron-updater` finds the signed build

Existing `electron-builder.yml` config (unchanged by this integration):

```yaml
publish:
  - provider: github
    owner: different-ai
    repo: openwork
    releaseType: release
```

`electron-updater` reads `latest.yml` (Windows) / `latest-mac.yml` /
`latest-linux.yml` from the most recent release assets on that
repo+owner. The signed installer + the matching `latest.yml` need to
land on the same release for clients to pick it up.

**For the fork**: change `owner` and `repo` to your fork's repository
before cutting the first signed release. Otherwise clients auto-update
to upstream different-ai/openwork, which doesn't have OpenShell.

---

## End-to-end smoke test before release

Before announcing a release, run this on a clean Windows 11 VM:

1. `wsl --unregister openwork-openshell` (if it exists)
2. Uninstall any existing OpenWork
3. Install the signed `*.exe`
4. Launch — confirm the setup wizard appears
5. Run the wizard through to "All components healthy"
6. Create a new local workspace, pick "OpenShell" as the sandbox
   backend
7. Start a session — confirm Doctor still reports `ready` afterward
8. Stop the session — confirm `wsl -d openwork-openshell -- openshell
   sandbox list` shows no surviving sandboxes
9. Reboot the VM — confirm OpenWork still works without a re-install

If steps 5–9 pass, the build is releasable.

The Phase 10 E2E spec (`apps/desktop/__tests__/openshell.spec.mjs`)
mechanizes most of this; run it on the VM after step 4:

```
$env:OPENWORK_E2E_OPENSHELL = "1"
pnpm --filter @openwork/desktop test:openshell:e2e
```

---

## Open decisions captured along the way

The spec's §9 asked us to lock these. Choices made during this fork:

| Decision | Choice | Rationale |
|---|---|---|
| Ship rootfs with installer or download on first run | **Bundle in MSI** | Works on locked-down networks where banker laptops can't reach GHA releases |
| Mid-session OpenShell-unhealthy fallback | **Hard-fail** | Honest about security degradation; auto-falling back to Docker would silently downgrade isolation |
| Default banking policy author | **Conservative shipped default, customer IT overrides** | Same pattern Rancher Desktop documents for enterprise deploys |
| Telemetry approach | **Out of scope for v1** | Banker-product telemetry has compliance considerations that vary firm to firm — separate spec |
| OpenShell update channel | **Pin per OpenWork release** | Predictability beats freshness for banking workloads |
| Test framework for openshell modules | **Node's built-in `node:test`** | Zero new deps; the desktop package had no prior unit-test framework |
| Sandbox backend default | **`docker`** (not openshell) | Docker works everywhere out of the box; banker opts into OpenShell via the new Settings → Sandbox tab |
| OpenEral integration | **Deferred** | OpenEral lives at the agent layer (inside the sandbox); the spec explicitly puts agent choice out of scope (§6). Revisit if it becomes strategically important. |

See `memory/project_openwork_followups.md` for the running list of
items deferred beyond v1, and the "Phase 7 deferred" note about the
renderer-side Tauri → Electron bridge needing rewiring before the
sandbox-backend selector actually takes effect at session start.
