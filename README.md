[![Discord](https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/VEhNQXxYMB)

# OpenWork

<div align="center">



**An extensible, open-source desktop application for agentic workflows**

Built on top of OpenCode, OpenWork transforms complex CLI workflows into intuitive, guided experiences for knowledge workers.

<img width="1292" height="932" alt="OpenWork Main Interface" src="https://github.com/user-attachments/assets/7a1b8662-19a0-4327-87c9-c0295a0d54f1" />

[Download Latest Release](https://github.com/different-ai/openwork/releases) · [Report Issues](https://github.com/different-ai/openwork/issues) · [Request Feature](https://github.com/different-ai/openwork/issues/new?template=feature_request.md)

</div>

---

##  Overview

OpenWork is designed to bridge the gap between powerful agentic systems and user-friendly interfaces. It wraps OpenCode's capabilities in a clean, desktop application that makes automated workflows accessible to non-technical users while maintaining full extensibility for developers.

### Key Features

-  **Native Desktop Experience** - Built with Tauri for performance and security
-  **Extensible Architecture** - Plugin system via OpenCode skills and packages
-  **Real-time Progress Tracking** - Live streaming of execution plans and results
-  **Permission Management** - Granular control over system access
-  **Template System** - Save and reuse common workflows
-  **Local & Remote Support** - Work locally or connect to remote OpenCode servers

---

##  Quick Start

### Prerequisites

Before contributing to OpenWork, ensure you have the following installed:

- **Node.js** (≥ 18.0.0) with [pnpm](https://pnpm.io/) package manager
- **Rust toolchain** - Install via [rustup](https://rustup.rs/):
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
- **Tauri CLI**:
  ```bash
  cargo install tauri-cli
  ```
- **OpenCode CLI** (available on PATH):
  ```bash
  opencode --version
  ```

### Installation & Development

1. **Clone the repository**
   ```bash
   git clone https://github.com/different-ai/openwork.git
   cd openwork
   ```

2. **Install dependencies**
   ```bash
   pnpm install
   ```

3. **Start development server**
   ```bash
   # Full desktop app (recommended)
   pnpm dev
   
   # Web UI only
   pnpm dev:ui
   ```

The application will be available in `packages/app` (UI) and `packages/desktop` (desktop shell).

---

##  Architecture

OpenWork follows a modular architecture with clear separation of concerns:

### Desktop Application Interface

<img width="1292" height="932" alt="OpenWork Desktop Interface" src="https://github.com/user-attachments/assets/b500c1c6-a218-42ce-8a11-52787f5642b6" />

```
openwork/
├── packages/
│   ├── app/          # React-based web UI
│   └── desktop/      # Tauri desktop shell
└── docs/             # Documentation and PRDs
```

### Core Components

- **Host Mode**: Spawns OpenCode server locally with configurable workspace
- **Client Mode**: Connects to remote OpenCode instances via URL
- **Session Management**: Create, manage, and persist OpenCode sessions
- **Real-time Updates**: SSE-based `/event` streaming for live progress
- **Execution Timeline**: Visual representation of OpenCode todo progress
- **Skills Manager**: Install and manage OpenCode skills from `.opencode/skill`

### Integration Architecture

The desktop application communicates with OpenCode via the `@opencode-ai/sdk/v2/client`, providing:

### Local and Remote Mode Support

<img width="1292" height="932" alt="OpenWork Local and Remote Modes" src="https://github.com/user-attachments/assets/9c864390-de69-48f2-82c1-93b328dd60c3" />
- Session lifecycle management
- Real-time event subscription
- Permission request handling
- Template persistence

---

##  Development Workflow

### Available Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start desktop app in development mode |
| `pnpm dev:ui` | Start web UI only |
| `pnpm typecheck` | Run TypeScript type checking |
| `pnpm build` | Build all packages for production |
| `pnpm build:ui` | Build web UI only |
| `pnpm test:e2e` | Run end-to-end tests |

### Code Quality Standards

Before submitting a PR, ensure:
-  `pnpm typecheck` passes without errors
-  `pnpm test:e2e` completes successfully
-  Code follows existing conventions (see existing components)
-  No breaking changes without proper documentation

---

##  Contributing

We welcome contributions! Please follow these guidelines:

### Before Contributing

1. **Read the project philosophy** in `AGENTS.md` and `MOTIVATIONS-PHILOSOPHY.md`
2. **Understand the codebase** by reviewing existing components and patterns
3. **Set up your environment** using the prerequisites above

### Making Changes

1. **Create a feature branch** from `main`
2. **Implement your changes** following existing conventions
3. **Add tests** if applicable
4. **Run quality checks**:
   ```bash
   pnpm typecheck
   pnpm test:e2e
   ```
5. **Submit a pull request** with clear description of changes

### Adding New Features

For significant features, create a PRD (Product Requirements Document) in `packages/app/pr/<feature-name>.md` following the conventions in `.opencode/skill/prd-conventions/SKILL.md`.

### Plugin Development

OpenWork supports OpenCode plugins for extensibility:

**Project Scope:** `<workspace>/opencode.json`
**Global Scope:** `~/.config/opencode/opencode.json`

Example plugin configuration:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-wakatime"]
}
```

---

##  Security Considerations

- OpenWork binds to `127.0.0.1` by default in host mode
- Model reasoning traces and sensitive tool metadata are hidden from the UI by default
- Capability permissions are defined in `packages/desktop/src-tauri/capabilities/default.json`
- File picker uses Tauri dialog plugin with proper sandboxing

---

##  Additional Resources

- [OpenCode Documentation](https://opencode.ai/docs)
- [Tauri Documentation](https://tauri.app/)
- [OpenPackage Registry](https://opkg.sh/)
- [Skill Development Guide](https://opencode.ai/skills)

---

##  License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

##  Acknowledgments

- Built on top of [OpenCode](https://opencode.ai/)
- Powered by [Tauri](https://tauri.app/) for the desktop experience
- UI built with [React](https://reactjs.org/) and modern web technologies

---

<div align="center">

**Made with ❤️ by the OpenWork community**

[Support us](https://github.com/sponsors/different-ai) · [Follow on Twitter](https://twitter.com/differentai) · [Join Discord](https://discord.gg/openwork)

</div>