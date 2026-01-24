# Security Overview

This document summarizes the current security posture of OpenWork and the related Owpenbot bridge, along with the key hardening measures implemented in this repository.

It is intentionally opinionated: OpenWork prefers safe-by-default behavior, explicit trust decisions, and clear local boundaries.

---

## 1. Architecture & Trust Boundaries

OpenWork is composed of three main pieces:

- **OpenWork UI** (`packages/app`)  
  SolidJS frontend that talks to an OpenCode engine over HTTP (local or remote).
- **Desktop shell** (`packages/desktop`)  
  Tauri v2 app that spawns and manages the OpenCode CLI locally in **Host mode**.
- **Owpenbot** (`packages/owpenbot`)  
  Node.js service that bridges WhatsApp/Telegram to a running OpenCode server.

Key trust boundaries:

- **Host mode (desktop)**  
  - OpenWork starts `opencode serve` on `127.0.0.1` with a workspace directory as the process CWD.  
  - The engine is local and shares the user’s filesystem permissions for that workspace.
- **Client mode (desktop)**  
  - OpenWork connects to a remote OpenCode server by URL.  
  - Trust is delegated to the remote server operator (file access, tools, plugins, MCPs).
- **Owpenbot**  
  - Bridges a chat channel (WhatsApp/Telegram) to **one OpenCode workspace**.  
  - Paired users get whatever tool access that workspace is configured with.

---

## 2. OpenCode CLI Version & CVE-2026-22812

A critical RCE vulnerability (CVE-2026-22812) affects **OpenCode server versions &lt; 1.1.10** due to a local HTTP server with permissive CORS.

OpenWork already depends on `@opencode-ai/sdk` versions that include the fix, but the actual **CLI binary version** on the user’s system was previously uncontrolled.

### Mitigations implemented

1. **Host-mode minimum version gate**

   In the Tauri desktop shell:

   - The `engine_start` command now:
     - Resolves the `opencode` executable as before.
     - Calls `opencode --version`, parses a semver-like prefix, and **refuses to start** if the version is clearly **older than `1.1.10`**.
   - If the version cannot be parsed, it is treated as “unknown” and is not blocked (to avoid breaking unusual builds), but the doctor notes (below) will highlight this for users.

2. **Version-aware `engineDoctor` warnings**

   - `engine_doctor` already:
     - Resolves the engine path (including sidecar support).
     - Checks whether `opencode serve` is available.
     - Returns `version`, `supportsServe`, and discovery `notes`.
   - It now additionally:
     - Parses the reported version.
     - Appends a note when the version is older than the recommended minimum (currently **`1.1.10`**), e.g.:

       > OpenCode CLI 1.1.5 is older than the recommended minimum 1.1.10. Update OpenCode to receive security fixes.

   - These notes are surfaced in the UI onboarding flow so users see **security-related upgrade guidance** instead of only “needs update”.

3. **CLI discovery strings updated**

   - All user-facing messages that previously suggested:

     ```bash
     curl -fsSL https://opencode.ai/install | bash
     ```

     have been updated to instead direct users to:

     - `brew install anomalyco/tap/opencode` (macOS/Homebrew), and  
     - `https://opencode.ai/install` for platform-specific instructions.

   - This avoids encouraging `curl | bash` patterns from the UI side.

---

## 3. Desktop Host vs Client Trust Models

### Host mode

- OpenWork runs OpenCode **locally** on `127.0.0.1` with a user-selected workspace directory.
- Tool calls (filesystem, shell, plugins, MCPs) execute with the **local user’s OS permissions**.
- The engine is only reachable locally; no remote WebView content is loaded in the desktop app.
- The desktop shell:
  - Uses Tauri capabilities minimally and only for:
    - Dialogs (folder picker),
    - Opener (open/reveal paths),
    - Process (relaunch),
    - Updater.
  - Does **not** expose arbitrary process spawning from the UI.

### Client mode

- OpenWork connects to an existing **remote** OpenCode server via URL.
- The remote server:
  - Determines what tools, plugins, and MCPs are available.
  - Owns the filesystem and process privileges for that workspace.
- Client mode should be treated as:

> “I trust this remote OpenCode server as much as I would trust an SSH shell into that machine.”

### Plugins, Skills, and MCPs

- **Plugins** and **skills** run in the OpenCode engine process (not in the OpenWork UI).
- **MCP servers** expose additional tools over the Model Context Protocol.
- In Host mode:
  - Plugin and MCP configuration is derived from `opencode.json` / `opencode.jsonc` / `.opencode/opencode.json`.
  - OpenWork manages these configs but does not broaden what OpenCode is allowed to do; it only edits config files that OpenCode already reads.
- In Client mode:
  - OpenWork does not read local `opencode.json` for that workspace; it relies on the remote server’s config, accessed via OpenCode’s API.

Security implication:

- Treat every added plugin, skill, or MCP as **code execution or data exfiltration surface** inside the engine.
- Prefer dedicated workspaces with minimal, scoped plugins instead of pointing at large monorepos or `$HOME`.

---

## 4. Owpenbot Hardening

Owpenbot (`packages/owpenbot`) connects WhatsApp/Telegram to a single OpenCode workspace. Misconfiguration can expose powerful tools (filesystem, shell, network) to anyone who can pair with the bot.

### 4.1 Permission model

Config type (simplified):

```ts
type PermissionMode = "allow" | "deny";
```

Previously:

- `PERMISSION_MODE` defaulted to `"allow"`.
- The bridge auto-approved permission prompts with `"always"`, giving paired users unrestricted tool access in the workspace.

Now:

- **Default is `"deny"`**:

  ```ts
  const permissionMode =
    env.PERMISSION_MODE?.toLowerCase() === "allow" ? "allow" : "deny";
  ```

- This means:
  - If `PERMISSION_MODE` is unset or anything other than `"allow"`, Owpenbot:
    - Creates sessions with `permission: [{ permission: "*", pattern: "*", action: "deny" }]`.
    - Auto-rejects any `permission.asked` events.
  - To regain the previous behavior, users must explicitly set:

    ```env
    PERMISSION_MODE=allow
    ```

**Strong recommendation:**

- Keep `PERMISSION_MODE=deny` for most deployments.
- If you set `PERMISSION_MODE=allow`, use a **dedicated, limited-scope workspace** just for Owpenbot (e.g. `/home/bot/owpenbot-workspace`), not your entire home directory or a production monorepo.

### 4.2 Owpenbot health server binding

Previously:

- The health server listened on `0.0.0.0`, exposing:
  - Bot presence,
  - Engine endpoint,
  - Channel status to the entire network.

Now:

- `startHealthServer` binds to **`127.0.0.1`**:

  ```ts
  server.listen(port, "127.0.0.1", () => { ... });
  ```

- The health endpoint is only reachable from localhost by default.
- To expose it remotely, use an explicit port forwarding/tunnel (e.g. `ssh -L`) rather than binding a network interface directly.

### 4.3 Owpenbot configuration defaults

Changes:

- Added `packages/owpenbot/.env.example` with:
  - `PERMISSION_MODE=deny`.
  - Comments that strongly recommend pointing `OPENCODE_DIRECTORY` at a **dedicated workspace** for Owpenbot.
- Updated `packages/owpenbot/README.md` to:
  - Emphasize the permission model and its implications.
  - Clarify that allowlisting and pairing should be used to restrict who can access the workspace.
  - Document the health server behavior and localhost binding.

### 4.4 Pairing and allowlists (unchanged behavior)

- Pairing uses a **6-digit numeric code** stored in SQLite (no expiry).
- An allowlist (`ALLOW_FROM`, `ALLOW_FROM_TELEGRAM`, `ALLOW_FROM_WHATSAPP`) controls which peers can talk to the bot at all.
- Security guidance:
  - Treat the pairing code as a **shared secret**, only exchanged out-of-band.
  - Prefer explicit allowlists for production bots.
  - Use a dedicated phone number / account for the bot so personal history is not exposed.

---

## 5. Workspace Roots & Path Handling

OpenWork maintains a set of **authorized workspace roots** that gate high-privilege operations such as `opencode mcp auth`.

### 5.1 Validation in Tauri commands

- `opencode_mcp_auth` uses `validate_project_dir` to ensure:
  - `project_dir` is non-empty.
  - Is an **absolute** path.
  - Canonicalizes the directory.
  - Confirms it is a directory.
  - Confirms it is **within an authorized root**, using canonical paths from `openwork.json` per workspace and the workspace state list.

If a path is not within an authorized root, the command fails with:

> `project_dir is not within an authorized root`

### 5.2 Canonicalization on write

To reduce confusion and symlink-related ambiguity:

- `WorkspaceOpenworkConfig::new` now:
  - Canonicalizes the workspace path before writing it into `.opencode/openwork.json`.
  - Stores the **canonical path** in `authorizedRoots` instead of the raw string.

- `workspace_add_authorized_root` now:
  - Canonicalizes both the workspace path and the new authorized folder path before writing.
  - Deduplicates roots based on the canonical string.

- `workspace_openwork_read` (for missing `.opencode/openwork.json`):
  - Synthesizes a default config using the **canonical workspace path** as the initial authorized root.

Combined with `validate_project_dir`, this means:

- Authorization decisions are made on **canonical paths**.
- Config files contain stable, fully-resolved paths, making it easier to reason about which directories are actually authorized.

---

## 6. Markdown Rendering & XSS Mitigation

The UI renders model output using `marked` with a custom renderer in:

- `packages/app/src/app/components/part-view.tsx`

Key defenses:

- **Raw HTML nodes**:
  - `renderer.html` is overridden to **escape** HTML (`&`, `<`, `>`), so arbitrary `<script>` or embedded tags are rendered as text.
- **Links & images**:
  - `renderer.link` and `renderer.image` check URLs and reject:
    - `javascript:` URLs.
    - `data:` URLs.
  - `href`, `title`, and `alt` text are escaped before being injected.
- **Remaining Markdown**:
  - Headings, paragraphs, lists, and blockquotes are rendered by `marked` with content escaped by default.
- The component sets `innerHTML` only once on a container that receives the sanitized `marked` output.

### Tests

A new integration script has been added:

- `packages/app/scripts/markdown-xss.mjs`

It:

- Recreates the same `marked` configuration used in the UI.
- Asserts that:
  - `<script>` tags are escaped (not executed).
  - `javascript:` and `data:` URLs are not present in generated HTML.
  - “Normal” HTTP/HTTPS links and images render correctly.

The script is wired into the UI package’s test suite via:

- `packages/app/package.json` → `test:markdown`
- Included in `test:refactor` so it runs with the rest of the integration tests.

---

## 7. Installers & `curl | bash`

Two installer touchpoints were previously encouraging `curl | bash` patterns:

1. **Desktop `engine_install` command (Tauri)**  
   - Used to run:

     ```bash
     bash -lc "curl -fsSL https://opencode.ai/install | bash"
     ```

   - This has been replaced with a **no-op install helper** that:
     - Returns a structured `ExecResult` with `ok: false` and status code `0`.
     - Logs **manual install instructions** (Homebrew + website URL) into `stdout`.
     - Produces a clear error message explaining that automatic install is disabled for security reasons and pointing to the logs.

2. **Owpenbot installer in the README**

   - The README previously recommended:

     ```bash
     curl -fsSL https://raw.githubusercontent.com/different-ai/openwork/dev/packages/owpenbot/install.sh | bash
     ```

   - This has been updated to a **two-step flow**:

     ```bash
     curl -fsSL https://raw.githubusercontent.com/different-ai/openwork/dev/packages/owpenbot/install.sh -o owpenbot-install.sh
     # Inspect owpenbot-install.sh, then:
     bash owpenbot-install.sh
     ```

   - The intention is to nudge users toward **reviewing the script** before execution.

All remaining references to `curl -fsSL https://opencode.ai/install | bash` in UI and Tauri error messages have been replaced with:

- `brew install anomalyco/tap/opencode`, and/or
- A link to `https://opencode.ai/install`.

---

## 8. Tauri Security & CSP

- The Tauri configuration (`packages/desktop/src-tauri/tauri.conf.json`) sets:

  ```json
  "security": {
    "csp": null
  }
  ```

- This is acceptable today because:
  - The app loads **no remote web content** into the WebView.
  - All frontend code is bundled locally from `packages/app/dist`.

Guidance for future contributors:

- If you introduce any remote content into the WebView (e.g. embedded documentation, external dashboards):
  - **Enable and tighten CSP** in `tauri.conf.json`.
  - Restrict script sources to the app bundle and trusted domains.
  - Avoid `unsafe-inline` and `unsafe-eval` in CSP; prefer hashed or nonce-based scripts.

---

## 9. Dependencies & Monitoring

- UI and Owpenbot dependencies are pinned to specific major/minor versions in `package.json` files (e.g. `@opencode-ai/sdk@^1.1.19`).
- Known checks:
  - The critical SDK-side vulnerability in older `@opencode-ai/sdk` versions is mitigated by using `>= 1.1.10`.
  - `@whiskeysockets/baileys`, `grammy`, and `better-sqlite3` are used at versions with no known critical CVEs at the time of this audit.

Recommended workflow:

- Run `pnpm audit` regularly and treat **high/critical** findings as blockers.
- Prefer explicit version bumps with PRs rather than floating ranges for high-risk libraries.

---

## 10. Summary & Recommendations for Operators

If you are running OpenWork or Owpenbot in a sensitive environment:

1. **Always use a patched OpenCode CLI**
   - Ensure `opencode --version` is **≥ 1.1.10**.
   - The desktop app will refuse to start older CLIs in Host mode, but remote servers are still your responsibility.

2. **Scope workspaces carefully**
   - Use small, purpose-specific folders as workspaces.
   - Avoid pointing OpenWork or Owpenbot at `$HOME` or wide shared volumes.

3. **Harden Owpenbot**
   - Keep `PERMISSION_MODE=deny` unless you fully understand the risk.
   - Use dedicated workspaces and explicit allowlists.
   - Treat the pairing code as a shared secret.

4. **Treat plugins, skills, and MCPs as code**
   - Review third-party code and configs before enabling.
   - Use separate workspaces for high-risk or experimental plugins.

5. **Avoid blind `curl | bash`**
   - Prefer package managers or explicit download + review steps.
   - When in doubt, read the installer script before running it.

Security is an ongoing process. This document is meant to be the baseline; future changes that affect attack surface or trust boundaries should be reflected here as the **source of truth** for the project’s security model.