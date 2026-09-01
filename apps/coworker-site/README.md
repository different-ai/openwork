# Open Coworker website

Static site for Open Coworker, built with the same stack as the desktop app
(Vite, React 19, Tailwind v4) so it can render the app's **own** brand mark and
coworker avatar components (`@/ui/brand`, `@/ui/coworker-avatar`) instead of
screenshots or redrawn assets. The `@/` alias resolves to `apps/coworker/src`,
exactly as it does inside the app.

## Truth-in-marketing

All copy lives in `src/content.ts`. Every product claim carries a `source`
pointing at the file, route, or contract in the product where it is true, and
`src/content.test.ts` fails when a claim has no source, when copy contains a
phrase the product cannot back (for example a download link that does not
exist), or when the two responsibility placements stop being described
distinctly. Change the product first, then the copy.

Vignettes in `src/mocks/product-mocks.tsx` are illustrations of real states in
the app's vocabulary and tones; they are not screenshots and do not show
features the app lacks.

## Develop

```bash
pnpm --filter @openwork/coworker-site dev        # http://127.0.0.1:5190
pnpm --filter @openwork/coworker-site test       # content honesty tests (node --test)
pnpm --filter @openwork/coworker-site typecheck
pnpm --filter @openwork/coworker-site build      # static output in dist/
pnpm --filter @openwork/coworker-site preview    # serve dist/ on http://127.0.0.1:5191
```

## Deploy

`dist/` is a plain static site: any static host works (Vercel static output,
GitHub Pages, S3). Set the site URL in `src/content.ts` (`SITE.url`) when the
domain is final. The avatar/mark motion rules in `src/styles.css` mirror
`apps/coworker/src/index.css`; keep them in sync when the app's motion changes.
