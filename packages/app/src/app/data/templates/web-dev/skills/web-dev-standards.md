---
name: web-dev-standards
description: |
  Full-stack web development standards for modern projects.

  Triggers when user mentions:
  - "create a component"
  - "set up a page"
  - "project structure"
  - "coding standards"
---

# Web Development Standards

You are a senior full-stack developer. Follow these standards for all code in this workspace.

## Stack

- **Framework**: Next.js 15 (App Router) or the framework already present in the project
- **Styling**: Tailwind CSS v4 with utility-first approach
- **Language**: TypeScript in strict mode — no `any`, no `@ts-ignore`
- **Package manager**: pnpm (or whatever lockfile already exists)

## Project structure

```
src/
  app/              # Routes (App Router)
    (marketing)/    # Route groups for layouts
    api/            # API routes
  components/
    ui/             # Reusable primitives (Button, Input, Card)
    features/       # Domain-specific composites
  lib/              # Utilities, constants, types
  hooks/            # Custom React hooks
  styles/           # Global CSS, Tailwind config
```

## Component rules

1. One component per file. File name = component name in kebab-case.
2. Props interface exported and named `<Component>Props`.
3. Use `"use client"` only when the component needs browser APIs or state.
4. Prefer Server Components by default.
5. Colocate tests: `button.test.tsx` next to `button.tsx`.

## Code style

- Functions over classes.
- Named exports over default exports (except for pages/layouts).
- Early returns over nested conditionals.
- Descriptive variable names — no single-letter variables outside loops.
- Comments explain *why*, not *what*.

## Performance

- Images: always use `next/image` with explicit `width`/`height`.
- Fonts: use `next/font` for self-hosted fonts.
- Dynamic imports for heavy components: `dynamic(() => import(...))`.
- Avoid barrel files (`index.ts` re-exports) in large directories.

## Accessibility

- All interactive elements must be keyboard-navigable.
- Images need meaningful `alt` text (or `alt=""` for decorative).
- Use semantic HTML: `<nav>`, `<main>`, `<article>`, `<section>`.
- Color contrast must meet WCAG AA (4.5:1 for text).

## Git conventions

- Commits: `type(scope): message` (e.g., `feat(auth): add login form`).
- Branch names: `feature/short-description`, `fix/short-description`.
- PRs: title matches commit convention, description includes screenshots for UI changes.
