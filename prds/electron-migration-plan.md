# Migration plan: Tauri → Electron

Goal: every existing Tauri user ends up on the Electron build without
manual action, keeps all workspaces / tokens / sessions, and continues to
auto-update from Electron going forward — all through the update mechanism
users already trust.

## Where data lives today

### Tauri shell — `app_data_dir()` per OS

| OS       | Path                                                     |
| -------- | -------------------------------------------------------- |
| macOS    | `~/Library/Application Support/com.differentai.openwork/`|
| Windows  | `%APPDATA%\com.differentai.openwork\`                    |
| Linux    | `~/.config/com.differentai.openwork/`                    |

Contents (observed on a real machine):
- `openwork-workspaces.json` (Tauri's name)
- `openwork-server-state.json`
- `openwork-server-tokens.json`
- `workspaces/` subtree

### Electron shell — `app.getPath("userData")` default

| OS       | Path                                           |
| -------- | ---------------------------------------------- |
| macOS    | `~/Library/Application Support/Electron/`      |
| Windows  | `%APPDATA%\Electron\`                          |
| Linux    | `~/.config/Electron/`                          |

Contents written today:
- `workspace-state.json` (Electron's name — differs from Tauri's)
- `openwork-server-state.json`
- `openwork-server-tokens.json`
- `desktop-bootstrap.json`

### Shared state (already portable)
- `~/.openwork/openwork-orchestrator/` — orchestrator daemon data
- Each workspace's own `.opencode/` — sessions, messages, skills, MCP config
- Neither has to migrate.

## Tauri updater today

- `apps/desktop/src-tauri/tauri.conf.json` →
  `endpoints: ["https://github.com/different-ai/openwork/releases/latest/download/latest.json"]`
- minisign signature required (pubkey baked into config)
- installs a DMG/zip in place

A straight-swap to an Electron installer fails: the Tauri updater
won't accept an asset that isn't minisign-signed in the format it expects.

## Plan

### 1 — Make Electron read the same folder Tauri writes

Before any user-facing migration, flip two knobs in the current PR's Electron
shell:

```js
// apps/desktop/electron/main.mjs
app.setName("OpenWork");
app.setPath(
  "userData",
  path.join(app.getPath("appData"), "com.differentai.openwork"),
);
```

```yaml
# apps/desktop/electron-builder.yml
appId: com.differentai.openwork   # (currently com.differentai.openwork.electron)
```

Effects:
- macOS Launchpad / Dock / notarization identity stay the same → Gatekeeper
  doesn't re-prompt, the icon doesn't split into two slots.
- First Electron launch finds the Tauri-written `openwork-server-*.json`
  already present → workspaces, tokens, orchestrator state survive with
  zero copy. Same `workspaces/` subtree, same orchestrator data dir, same
  workspace `.opencode/` dirs (they live inside user folders anyway).

Filename compatibility layer:

```js
// Electron runtime on load, once per launch
async function readWorkspaceState() {
  const legacy = path.join(userData, "openwork-workspaces.json"); // Tauri
  const current = path.join(userData, "workspace-state.json");   // Electron
  if (existsSync(legacy) && !existsSync(current)) {
    await rename(legacy, current); // idempotent migration
  }
  return existsSync(current) ? JSON.parse(await readFile(current)) : EMPTY;
}
```

### 2 — One final Tauri release: v0.12.0-migrate

This release uses the existing Tauri updater. Users click "Install update"
as they always do. What v0.12.0-migrate ships:

1. A single new command `migrate_to_electron()` in the Tauri shell that:
   - Downloads the matching Electron installer from the same GitHub Release
     (`OpenWork-0.12.0-mac-<arch>.dmg`, `.exe`, `.AppImage`).
   - Verifies signature via OS-native tools (`codesign --verify --deep --strict`
     on mac, Authenticode on Windows, minisign or GH attestations on Linux).
   - Opens the installer and schedules Tauri quit.

2. A one-time prompt:

   > OpenWork is moving to a new desktop engine. We'll install the new
   > version and keep all your workspaces. ~30 seconds.
   > [Install now] [Later]

   "Later" defers 24h once, then force-installs on next launch — no
   indefinite stragglers.

3. `tauri.conf.json.version` → `0.12.0`, `latest.json.version` → `0.12.0`,
   minisign-signed as usual. Installed = still a Tauri binary, but whose
   only remaining job is to launch the Electron installer.

This is the only new Tauri release required. After v0.12.0 we stop
publishing `latest.json` updates.

### 3 — Flow (ASCII)

```
Tauri v0.11.x
      │  (normal Tauri updater poll)
      ▼
latest.json says 0.12.0 is out → DMG installed in-place → Tauri v0.12.0-migrate
      │  on first launch shows migration prompt
      ▼
migrate_to_electron():
  download OpenWork-0.12.0-electron-mac.dmg from same release
  codesign --verify ✓
  open installer, schedule Tauri quit
      │
      ▼
Installer replaces the .app bundle
  appId = com.differentai.openwork (same as Tauri)
  Launchpad slot + Dock pin preserved, no duplicate "OpenWork" icon
      │
      ▼
OpenWork Electron v0.12.0 first launch
  app.setPath("userData", .../com.differentai.openwork) points at the
  Tauri-written folder → tokens, workspaces, orchestrator state already there
  rename openwork-workspaces.json → workspace-state.json (once)
      │
      ▼
electron-updater now owns the feed (latest-mac.yml, latest.yml, latest-linux.yml)
  every future release is an Electron-only .dmg / .exe / .AppImage
```

### 4 — Post-migration auto-updater

Use `electron-updater` (ships with `electron-builder`) against the same
GitHub release stream:

```yaml
# apps/desktop/electron-builder.yml
publish:
  - provider: github
    owner: different-ai
    repo: openwork
    releaseType: release
mac:
  notarize: true           # reuse existing Apple Developer ID
  icon: src-tauri/icons/icon.icns
win:
  sign: ./scripts/sign-windows.mjs   # reuse existing EV cert
  icon: src-tauri/icons/icon.ico
```

Runtime:

```js
import { autoUpdater } from "electron-updater";
autoUpdater.channel = app.isPackaged ? (releaseChannel ?? "latest") : "latest";
autoUpdater.autoDownload = prefs.updateAutoDownload;
autoUpdater.checkForUpdatesAndNotify();
```

Alpha/beta channels reuse the existing alpha GitHub release (the current
`alpha-macos-aarch64.yml` workflow publishes to `alpha-macos-latest`;
switch its `generate-latest-json.mjs` step to emit `latest-mac.yml` instead).

Delta updates: electron-updater's block-map diffs drop a typical mac update
from ~120MB full bundle to ~5-20MB. A net win over Tauri's no-delta default.

### 5 — Release-engineering changes

- `Release App` workflow:
  - Replaces `tauri build` with `pnpm --filter @openwork/desktop package:electron`.
  - Uploads DMG + zip + `latest-mac.yml` + `latest.yml` + `latest-linux.yml`
    to the same GitHub release asset list.
  - Keeps publishing minisign-signed `latest.json` for the v0.12.0 release
    only (so current Tauri users can pick up the migration update). After
    that release, stop updating `latest.json`.
- `build-electron-desktop.yml` (already scaffolded in this PR): flip to a
  required check once the migration release is in flight.

### 6 — Rollout

| Stage   | Audience            | What ships                                                                  |
| ------- | ------------------- | --------------------------------------------------------------------------- |
| Week 0  | this PR merged      | Electron co-exists, Tauri is default, no user impact                        |
| Week 1  | internal            | Dogfood `pnpm dev:electron` on same data dir as Tauri                       |
| Week 2  | alpha channel       | First real Electron release via alpha updater. Only opt-in alpha users get it. |
| Week 3  | stable — v0.12.0    | Migration release. Tauri prompt → Electron install → back online, same data.|
| Week 4+ | stable — v0.12.x    | Electron-only. Tauri `latest.json` frozen.                                  |

### 7 — Rollback

- Users already on Electron: ship `0.12.1` through `electron-updater`. Same
  mechanism as any normal update.
- Users still on Tauri: they never received the migration prompt; they stay
  on Tauri. Pull `latest.json` if there's a systemic issue.
- Users mid-migration: Tauri is only quit *after* the Electron installer
  finishes writing the new bundle. If the installer aborts, Tauri remains
  the working app until the user retries.

### 8 — Risks and mitigations

- **Bundle-identifier drift**. If Electron `appId` is different from Tauri,
  macOS treats it as a separate app (new Launchpad icon, new Gatekeeper
  prompt, new TCC permissions). Fixed in step 1 by unifying to
  `com.differentai.openwork`.
- **Notarization / signing**. Electron builds need Apple Developer ID +
  notarization for the same team. Reusing the existing Tauri CI secrets
  (`APPLE_CERTIFICATE`, `APPLE_API_KEY`, etc.) makes this a config change
  rather than a new credential story.
- **Electron bundle size**. First Electron update is ~120MB vs ~20MB today.
  Mac universal build keeps it to one download per platform. Future deltas
  via block-map diffs recover most of the gap.
- **Third-party integrations depending on the Tauri identifier** (Sparkle,
  crash reporters, etc.): none in the current build, so zero action.

### 9 — Concrete next-step PRs (order matters)

1. **This PR** (#1522) — Electron shell lives side-by-side. No user impact.
2. **Follow-up PR**: "unify app identity with Tauri". Flips `appId` to
   `com.differentai.openwork`, points `userData` at the Tauri folder, adds
   the `openwork-workspaces.json` → `workspace-state.json` rename.
3. **Follow-up PR**: "electron-updater + release workflow". Wires
   electron-builder `publish:` config, teaches `Release App` to emit the
   electron-updater feed manifests.
4. **Final PR**: "last Tauri release v0.12.0". Ships the Tauri
   `migrate_to_electron` command + prompt. Triggers migration for every
   existing user on their next Tauri update.

After (4) lands and rolls out, flip the default
`apps/desktop/package.json` scripts so `dev` / `build` / `package` use
Electron, and delete `src-tauri/`.
