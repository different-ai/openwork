---
name: electron-solidjs
description: Electron main/preload + SolidJS stack for OpenWork desktop app
---

## Quick Usage (Already Configured)

### Development
```bash
pnpm dev
```

### Build for production
```bash
pnpm --dir packages/desktop build:electron
```

### Typecheck desktop shell
```bash
pnpm --filter @different-ai/openwork typecheck:electron
```

## Project Structure

```text
openwork/
  packages/
    app/
      src/
      package.json
    desktop/
      src/main/
        main.ts          # Electron main entry point
        preload.ts       # Typed preload bridge
        services/        # Privileged desktop services
      resources/
        sidecars/
      electron-builder.yml
      package.json
```

## Key Principles

- Keep privileged work in Electron main.
- Expose a narrow typed `window.openworkDesktop` bridge from preload.
- Do not import Electron or Node directly from SolidJS renderer code.
- Prefer renderer `fetch` for loopback/server calls unless a narrow bridge is required.

## Common Gotchas

- Electron packaging needs sidecars staged outside ASAR (`resources/sidecars`).
- Desktop runtime checks should use `window.openworkDesktop`, not Tauri globals.
- Renderer shell/dialog/path access should flow through preload namespaces, not direct imports.

## References

- `packages/desktop/src/main/main.ts`
- `packages/desktop/src/main/preload.ts`
- `packages/app/src/app/lib/openwork-desktop.ts`
- `packages/app/src/app/lib/tauri.ts`
