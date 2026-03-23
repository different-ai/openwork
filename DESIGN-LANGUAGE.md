# OpenWork Design Language

This is the definitive visual language for OpenWork product and marketing work.

The goal is calm, premium, operational software: clear, flat, slightly futuristic, and trustworthy enough for real work. It is an application, not a marketing page. Readability, state clarity, and keyboard/mouse efficiency matter more than visual theater.

## Core Directives

1.  **No Glassmorphism:** Never use `backdrop-blur`, heavy drop shadows, or frosted glass (`bg-white/70`, `bg-white/94`) on core application UI surfaces.
2.  **No Extraneous Chrome:** Do not add decorative counters, pills, lines, or badges unless they map directly to functional state.
3.  **No Aggressive Gradients:** Do not use radial gradients or linear background washes behind application panels.
4.  **Flat Hierarchy:** The app relies on very soft, low-contrast separation, mostly handled by `1px` subtle borders and flat semantic backgrounds (`bg-gray-1`, `bg-gray-2`, `bg-gray-3`).
5.  **Preserve the Anchor:** Never hide or truncate a primary label (like a workspace name) just to reveal hover actions. Hover actions must sit in reserved space or overlay without pushing text.

## Shared DNA

### Brand Mood

*   Calm, technical, premium, useful.
*   More "precision tool with atmosphere" than "consumer toy".
*   Friendly, but never cute.
*   Futuristic through restraint, flat surfacing, and structural cleanliness—not chrome overload.

### Core Palette

The application runs on a tight monochrome grayscale with intentional accent colors.

*   Base background: `bg-dls-sidebar` or `bg-gray-1`
*   Primary ink: `text-gray-12`
*   Secondary ink: `text-gray-10` or `text-gray-11`
*   Subtle borders: `border-dls-border` or `border-gray-6`
*   Soft panels: `bg-gray-1`, `bg-gray-2/60`, `bg-gray-3/70`

### Geometry

*   Panels and large modals: `rounded-2xl` or `rounded-[28px]` (do not use `rounded-[2rem]` for utility panels).
*   Lists, tabs, and small cards: `rounded-xl`.
*   Badges and accents: `rounded-full` or `rounded-md`.
*   Avoid overly pill-shaped geometry outside of primary buttons and badges.

### Typography

*   Primary UI type: a clean sans like Inter.
*   Monospace: use for commands, file paths, versions, code snippets, and system tokens.
*   Default hierarchy:
    *   Eyebrows: uppercase, tracked (`tracking-[0.18em]`), small (`text-[11px]`), muted (`text-gray-8`).
    *   Headlines: medium or semibold weight, tight tracking, moderate scale (`text-lg` or `text-[1.35rem]`).
    *   Body: relaxed line-height, soft gray (`text-gray-10`), high legibility.
    *   List Items: `text-[13px]`, not overly large.

## Application Surfaces

### Panels & Cards

*   Instead of floating cards, use structured boundaries.
*   A major settings panel should use `bg-dls-surface` or `bg-gray-1/40` with a subtle `border-dls-border` (see `_repos/openwork/apps/app/src/app/pages/settings.tsx`).
*   Secondary interior groupings should use `bg-gray-1/40` or `bg-gray-2/30` with `rounded-2xl` and a `1px` border.

### Interactive Rows & Lists (The Landing Pattern)

Lists (like sessions or active configurations) should mimic the clean, flat rhythm seen in the landing demo panels (see `_repos/openwork/ee/apps/landing/components/landing-app-demo-panel.tsx`).

*   **Container:** `flex items-center justify-between rounded-xl px-3 py-1.5 text-left text-[13px] transition-colors` (see `_repos/openwork/apps/app/src/app/components/session/workspace-session-list.tsx` for implementation details).
*   **Selected State:** Use a solid, clear gray tint like `bg-gray-3` or `bg-gray-3/80` with a stronger font weight (`font-medium`). Do *not* use a white card with drop shadow.
*   **Hover State:** Use a slightly lighter tint than the selected state, e.g., `hover:bg-gray-2/60`.
*   **Timestamps/Metadata:** Keep them quiet. Right-aligned `text-[11px] text-gray-8` or `text-gray-9`. Do not brighten them excessively on hover.

### Navigation Rails

*   Use flat, unadorned rectangles for tabs (see left rail in `_repos/openwork/apps/app/src/app/pages/settings.tsx`).
*   Active state: `bg-dls-surface text-dls-text shadow-sm` (keep the shadow minimal).
*   Hover state: `hover:bg-dls-surface/50`.
*   Do not use heavy floating dots, massive padding, or glowing active states.

### Hover Actions

*   Row-level actions (like `...` or `+`) should appear on hover (`group-hover:flex`).
*   **Crucial:** Do not use `opacity-0 group-hover:opacity-100` if it causes the primary text of the row to truncate early or jump. Prefer `hidden group-hover:flex` to naturally replace space, but ensure the title has enough room.

### Buttons & Controls

*   **Primary Button:** Dark fill (`bg-[#011627]`), white text, `rounded-full`, compact horizontal padding.
*   **Secondary/Outline Button:** Transparent background, `border-dls-border`, `text-dls-text`, hover state `bg-dls-hover` or `bg-gray-2`.
*   **Danger Action:** Very subtle red tint `bg-red-3/25 text-red-11 border-red-7/35`.

## OpenWork Landing

The landing page (`_repos/openwork/ee/apps/landing`) may use *slightly* more atmospheric elements (like soft grain or the occasional translucent shell), but the core UI components embedded within it (like `LandingAppDemoPanel` or `LandingCloudWorkersCard`) strictly obey the flat, structural rules outlined above.

*   The landing page is the *only* place where `landing-shell` (frosted blur) is appropriate. Do not backport these utility classes into the operational desktop application.
*   When the desktop app needs to look "premium", it achieves this through tight alignment, consistent `gray-1`/`gray-2` layering, and sharp typography—not through blurs and shadows.

## Canonical References

If you need to see exactly how these rules are applied in code, consult these specific source files:

*   **App Settings Panel (Ideal flat surface structure):** `_repos/openwork/apps/app/src/app/pages/settings.tsx`
*   **App Left Rail (Ideal tab and session list rhythm):** `_repos/openwork/apps/app/src/app/components/session/workspace-session-list.tsx`
*   **Landing Demo Shell (The origin of the clean list layout):** `_repos/openwork/ee/apps/landing/components/landing-app-demo-panel.tsx`
