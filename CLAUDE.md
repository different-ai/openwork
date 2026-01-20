# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## OpenWork Overview

OpenWork is a native desktop application (Tauri 2.x + SolidJS) that provides a user-friendly wrapper around the OpenCode CLI. It presents OpenCode as a guided, visual workflow for knowledge workers.

**Core Architecture:**
- **Host Mode**: Spawns `opencode serve` locally on user-selected project folders
- **Client Mode**: Connects to existing remote OpenCode servers
- **UI Integration**: Uses `@opencode-ai/sdk` for API communication
- **Event Streaming**: SSE `/event` subscription for real-time updates

## Development Commands

### Running and Building
```bash
pnpm dev          # Start Tauri development mode (desktop app)
pnpm dev:web      # Web-only development mode
pnpm build        # Build desktop application
pnpm build:web    # Build web version
```

### Type Checking
```bash
pnpm typecheck    # TypeScript type checking
```

### Testing
```bash
pnpm test:health         # Health check tests
pnpm test:sessions       # Session management tests
pnpm test:events         # Event streaming tests
pnpm test:todos          # Task execution tests
pnpm test:permissions    # Permission handling tests
pnpm test:session-switch # Session switching tests
pnpm test:fs-engine      # File system engine tests
pnpm test:e2e            # Full end-to-end test suite
```

### Version Management
```bash
pnpm bump:patch    # Bump patch version (0.1.22 -> 0.1.23)
pnpm bump:minor    # Bump minor version (0.1.22 -> 0.2.0)
pnpm bump:major    # Bump major version (0.1.22 -> 1.0.0)
pnpm bump:set -- 0.1.21  # Set exact version
```
Version bumps automatically sync `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.

## Codebase Structure

### Frontend (`src/`)
- **`views/`**: Main application screens
  - `DashboardView` - Hub with workspace selection, session management
  - `SessionView` - Active session with messages and progress tracking
  - `OnboardingView` - First-time setup
  - `SkillsView` - Skill management (install/list OpenCode skills)
  - `PluginsView` - Plugin configuration via `opencode.json`
  - `TemplatesView` - Workflow template management
  - `SettingsView` - Application preferences

- **`components/`**: Reusable UI components
  - `WorkspacePicker` - Folder selection for workspaces
  - `ModelPickerModal` - Model selection interface
  - `TemplateModal` - Template creation/management
  - `CreateWorkspaceModal` - New workspace setup
  - Permission request/response modals

- **`app/`**: Application logic layer
  - `workspace.ts` - Workspace management
  - `session.ts` - Session handling and messaging
  - `templates.ts` - Template management
  - `plugins.ts` - Plugin configuration
  - `constants.ts` - Default models, curated packages
  - `types.ts` - TypeScript type definitions

### Backend (`src-tauri/`)
Rust-based Tauri backend with minimal footprint. See Tauri documentation for details.

## OpenCode Integration

OpenWork uses the official SDK: `@opencode-ai/sdk/v2/client`

**Key SDK Methods:**
- `client.global.health()` - Startup checks and diagnostics
- `client.session.create/list/get/messages/prompt/abort()` - Session management
- `client.event.subscribe()` - SSE event streaming for real-time updates
- `client.permission.reply({ requestID, reply })` - Permission responses (`once` | `always` | `reject`)
- `client.find.text/files/symbols()` - File search
- `client.file.read/status()` - File operations
- `client.config.get/providers()` - Settings and providers

## Extension System

OpenWork uses OpenCode's native extension primitives:

1. **Skills** - Installed via `opkg install` into `.opencode/skill/*`
2. **Plugins** - Configured via `opencode.json` in workspace or global config (`~/.config/opencode/opencode.json`)
3. **MCP** - For authenticated third-party flows with OAuth
4. **Templates** - OpenWork-specific abstraction stored in `.openwork/templates/`

**Plugin Configuration Format:**
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-wakatime"]
}
```

## Design Philosophy

Key principles from AGENTS.md and MOTIVATIONS-PHILOSOPHY.md:

- **Parity with OpenCode**: UI actions map cleanly to OpenCode APIs
- **Prefer OpenCode primitives**: Use native OpenCode surfaces (folders, `.opencode`, `opencode.json`, skills, plugins) before introducing new abstractions
- **Purpose-first UI**: Clarity, safety, and approachability for non-technical users
- **Transparency**: Plans, steps, tool calls, and permissions are visible
- **Least privilege**: Only user-authorized folders with explicit approvals
- **Mobile-native**: Touch targets, gestures, and layouts optimized for small screens
- **60fps animations**: Premium feel with micro-interactions

## OpenPackage Fallback

If `opkg` is not installed globally, OpenWork falls back to:
```bash
pnpm dlx opkg install <package>
```

## Security Notes

- Host mode binds to `127.0.0.1` by default
- Model reasoning and sensitive tool metadata are hidden by default
- Folder authorization enforced through two layers: OpenWork UI + OpenCode permissions

## Creating a Release

1. Ensure `dev` branch is green and up to date
2. Bump versions using `pnpm bump:patch/minor/major`
3. Merge the version bump to `dev` (main branch)
4. Create and push tag: `git tag vX.Y.Z && git push origin vX.Y.Z`

This triggers the GitHub Actions `Release App` workflow automatically.
