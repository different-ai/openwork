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

## Agent-ready and shareable

- `public/start.md` is a start guide written for agents (prerequisites, exact
  commands, first-run choices, on-disk verification). `public/llms.txt`
  follows llmstxt.org. The page offers a copyable prompt that points a
  person's own agent at `/start.md` on whatever origin the site is served from.
- `index.html` carries canonical, Open Graph, Twitter card, manifest, and
  JSON-LD (`SoftwareApplication` + `Organization` + `WebSite`) metadata.
  `src/metadata.test.ts` keeps every URL-bearing file in agreement with
  `SITE.url` and checks that `public/og.png` is a real 1200×630 PNG.
- Regenerate the share image after brand changes with
  `pnpm --filter @openwork/coworker-site og:render` (renders
  `scripts/og-card.html` through Electron; same bubble geometry and palettes
  as the app).

## Revenue path

Open Coworker is free and open source. The paid product underneath is
OpenWork Cloud, so the page's Cloud section sends people to the real
sign-up (`app.openworklabs.com?mode=sign-up`, UTM-tagged as
`opencoworker`) and to OpenWork pricing and enterprise pages. There is no
waitlist backend; "hear about what's next" uses GitHub release watching and
the team inbox. Nothing unshipped is sold: the one roadmap statement on the
page is typed `planned`, sourced to the product plan, and the tests require
it to read as direction.

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
