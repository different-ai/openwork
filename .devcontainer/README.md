# Daytona / Dev Container Setup

Full-stack dev environment that runs the entire OpenWork + Den stack in a cloud sandbox.

## What's included

| Service | Port | Description |
|---------|------|-------------|
| **App (Vite)** | 5173 | The OpenWork React UI — no Electron needed, runs as a web app |
| **Den Web** | 3005 | Admin dashboard for managing orgs, restrictions, providers |
| **Den API** | 8788 | Control plane API |
| **MySQL** | 3306 | Database (internal, not forwarded) |

## Quick start with Daytona

```bash
daytona create https://github.com/different-ai/openwork
```

This will:
1. Spin up a workspace with Node.js 20 + MySQL
2. Install dependencies (`pnpm install`)
3. Push the DB schema
4. Start Den API, Den Web, and the App dev server
5. Forward ports 5173, 3005, 8788

## Quick start with VS Code Dev Containers

1. Open the repo in VS Code
2. Cmd+Shift+P → "Dev Containers: Reopen in Container"
3. Wait for build + services to start
4. Ports are auto-forwarded

## Testing the customization system

1. Open **Den Web** (port 3005)
2. Sign up with any email (dev mode auto-approves)
3. Create an org
4. Go to **Org Settings** → **UI Customization**
5. Set any override (e.g., "Status bar" → "Always hide")
6. Save

Then:

1. Open the **App** (port 5173)
2. Go to **Cloud** → enable developer mode → set base URL to `http://localhost:3005`
3. Sign in with the same account
4. Go to **Settings** → **Customization**
5. The "Status bar" toggle should be locked with a "Managed" badge

## Architecture

```
┌─────────────────────────────────────────────┐
│  Daytona Workspace                          │
│                                             │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
│  │ App     │  │ Den Web  │  │ Den API   │  │
│  │ :5173   │  │ :3005    │  │ :8788     │  │
│  │ (Vite)  │  │ (Next.js)│  │ (Hono)    │  │
│  └────┬────┘  └────┬─────┘  └─────┬─────┘  │
│       │             │              │         │
│       │    GET /v1/me/desktop-config         │
│       └─────────────┼──────────────┘         │
│                     │                        │
│              ┌──────┴──────┐                 │
│              │   MySQL     │                 │
│              │   :3306     │                 │
│              └─────────────┘                 │
└─────────────────────────────────────────────┘
```

## Notes

- **No Electron**: The app runs as a plain web app via Vite. All features work except Electron-specific ones (file system access, native browser panel, window management).
- **OTP codes**: In dev mode, email verification codes are logged to the Den API stdout. Check the terminal.
- **Hot reload**: Vite HMR works for the app. Den API/Web need manual restart if you change their source.
