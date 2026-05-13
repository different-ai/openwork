# Daytona / Dev Container Setup

Full-stack dev environment that runs the **real Electron app** + Den stack in a cloud sandbox. You see and steer the desktop app through your browser via noVNC.

## What's included

| Service | Port | Description |
|---------|------|-------------|
| **Desktop App (noVNC)** | 6080 | The real Electron app rendered in a virtual display, accessible in your browser |
| **Den Web** | 3005 | Admin dashboard for managing orgs, restrictions, providers |
| **Den API** | 8788 | Control plane API |
| **CDP Debug** | 9825 | Chrome DevTools Protocol — for automation and Chrome MCP |
| **Vite HMR** | 5173 | Hot module replacement for the React UI |
| **MySQL** | 3306 | Database (internal) |

## Quick start with Daytona

```bash
daytona create https://github.com/different-ai/openwork
```

Then open port 6080 in your browser — you'll see the actual OpenWork desktop app.

## How it works

1. **Xvfb** creates a virtual X display (`:99`) inside the container
2. **Electron** renders the app on this virtual display
3. **x11vnc** captures the display and serves it as VNC
4. **noVNC** (port 6080) wraps VNC in a web client you can open in any browser
5. You can click, type, and interact with the full Electron app through noVNC
6. **CDP on port 9825** enables Chrome MCP and Playwright automation

## Testing the customization system

1. Open **Den Web** (port 3005) in a separate tab
2. Sign up → create org → Org Settings → UI Customization
3. Set overrides → Save
4. In the **Electron app** (noVNC on port 6080):
   - Cloud → developer mode → base URL `http://localhost:3005`
   - Sign in → Customization → see locked toggles

## Architecture

```
Your Browser
    │
    ├── :6080 noVNC ──▶ Xvfb ──▶ Electron App (real desktop app)
    │                              │
    │                              ├── CDP :9825 (automatable)
    │                              └── Vite HMR :5173
    │
    ├── :3005 Den Web (Next.js)
    │
    └── :8788 Den API (Hono) ──▶ MySQL :3306
```

## Automation

The Electron app exposes CDP on port 9825. You can:

- Connect Playwright: `const browser = await chromium.connectOverCDP('ws://localhost:9825')`
- Connect Chrome MCP for AI agent testing
- Take screenshots, run UI tests, etc.
