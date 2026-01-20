# UI Dark Mode + Radix Colors

## Summary
Introduce system-aware dark mode support, persistable theme preferences, and a Radix Colors-driven palette that automatically swaps between light/dark without per-utility `dark:` modifiers. Upgrade Tailwind to v4 as the foundation.

## Goals / Non-goals
- Goals
- Upgrade Tailwind from v3 to v4 for the frontend.
- Add theme primitives that detect system preference, allow explicit user override, and persist choice.
- Integrate Radix Colors and map them into Tailwind so utilities like `bg-red-5` resolve to light/dark values automatically.
- Ensure the app renders correctly in desktop (Tauri) and web preview modes.
- Non-goals
- Redesign every screen or audit every color usage in this PRD; focus on system and tokens first.
- Add `dark:` variants to existing classes across the app.
- Introduce a new design system beyond Radix Colors and existing layout styles.

## Definitions
- Theme mode: `light`, `dark`, or `system` (follow OS preference).
- Theme attribute: The DOM attribute (e.g. `data-theme`) used to indicate the active theme.
- Radix scale: A 12-step scale (1-12) per color from `@radix-ui/colors`.

## Guiding principles
- Default to system preference when no explicit choice exists.
- Theme switching should be flicker-free and safe for app startup.
- Use CSS variables for color tokens so Tailwind utilities stay theme-agnostic.
- Keep the integration compatible with both Tauri webview and Vite dev server.

## Current state / problem
- Tailwind is currently v3 with a small custom config in `tailwind.config.ts`.
- Global styles set `color-scheme: dark` in `src/styles.css`, forcing dark UI even when the system is light.
- There are existing localStorage keys for mode preferences (e.g. `openwork.modePref` and `openwork_mode_pref`), but no centralized theme application logic.
- Some components use ad-hoc tone props (e.g. `tone="dark"`) instead of a global theme.

## Proposal
### 1) Tailwind v4 upgrade
- Upgrade to Tailwind v4 and switch to the Vite plugin (`@tailwindcss/vite`) for build performance.
- Remove the PostCSS plugin setup and `autoprefixer`, since v4 handles imports and prefixes.
- Migrate `@tailwind` directives to `@import "tailwindcss"` in the main stylesheet.
- Keep `tailwind.config.ts` only if needed, otherwise move theme tokens to CSS via `@theme`.
- If `tailwind.config.ts` is kept, add `@config` in the main stylesheet to load it explicitly.
- Audit for v4 breaking changes that affect existing classes (ring defaults, outline-none, shadow-sm, etc.).

### 2) Theme detection + persistence
- Add a dedicated theme module (e.g. `src/app/theme.ts`) that exposes:
  - `mode()` signal: `light | dark | system`.
  - `resolvedMode()` signal: `light | dark` (system-resolved).
  - `setMode(next)` with persistence to localStorage (reuse `openwork.modePref`).
- Apply the initial theme before first paint (inline script or early bootstrap) to avoid flash.
- On app bootstrap, set a `data-theme` attribute on the `html` element based on `mode` + `window.matchMedia("(prefers-color-scheme: dark)")`.
- Listen for `(prefers-color-scheme: dark)` changes via the `matchMedia` listener when `mode === system` and update `data-theme` live.
- Update `color-scheme` on `html` to match the resolved theme for native controls.
- Use `window.matchMedia` for system detection in both Tauri and web; no Tauri-specific API required.

### 3) Radix Colors integration (no `dark:` modifiers)
- Install `@radix-ui/colors` and import CSS scales once in the global stylesheet.
- Use CSS variables to map Radix scales to Tailwind theme tokens.
  - Light: `:root { --color-red-1: var(--red-1); ... }`
  - Dark: `[data-theme="dark"] { --color-red-1: var(--red-dark-1); ... }`
- Define Tailwind colors to use these variables so utilities like `bg-red-5` map to `var(--color-red-5)`.
- Implement the mapping in CSS via Tailwind v4 `@theme` so utilities resolve without JS config.
- Provide a single source of truth for gray/mauve/slate scales to drive background, border, and text defaults.

## UX / flows
- Default behavior: on first launch, theme follows OS. No user action required.
- When a user selects a theme (light/dark/system), the choice is applied immediately and persisted.
- Theme changes should not cause page reloads; CSS variables should swap in-place.

## Data / storage
- Persist `mode` in localStorage under the existing key: `openwork.modePref`.
- Store only `light | dark | system` and remove legacy `openwork_mode_pref` over time.

## Migration
- Remove `color-scheme: dark` from `src/styles.css` and replace with a `color-scheme` that follows `data-theme`.
- Introduce global CSS variables for Radix colors and map Tailwind theme tokens to them.
- Replace ad-hoc `tone` usage where possible, or map it to the global theme state.
- Decide whether to keep `tailwind.config.ts` or fully migrate to CSS-based config to reduce upgrade friction.

## Acceptance criteria
- Tailwind v4 compiles successfully and the app boots in dev and Tauri.
- Theme defaults to system preference with no visible flash.
- Theme choice persists across restarts and applies on first paint.
- A class like `bg-red-5` renders different colors in light vs dark without `dark:` usage.
- Radix color scales (including grays) are available for text, background, border, and accent utilities.

## Open questions
- Should the theme preference be stored in localStorage only, or also in a project/workspace setting?
- Do we want a small UI toggle in the app settings now, or is this PRD limited to infra?
- Which Radix neutral scale should be the default base (gray vs slate vs mauve)?
