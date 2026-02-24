---
name: deployment-checklist
description: |
  Pre-deployment checklist for web applications.

  Triggers when user mentions:
  - "ready to deploy"
  - "pre-launch checklist"
  - "go live"
  - "deployment review"
---

# Deployment Checklist

Use this checklist before any production deployment. Go through each section and report pass/fail status.

## 1. SEO

- [ ] Every page has a unique `<title>` and `<meta name="description">`.
- [ ] Open Graph tags (`og:title`, `og:description`, `og:image`) are set for shareable pages.
- [ ] `robots.txt` exists and allows indexing of public pages.
- [ ] `sitemap.xml` is generated and submitted.
- [ ] Canonical URLs are set to avoid duplicate content.
- [ ] Structured data (JSON-LD) is present for key pages (articles, products, FAQ).

## 2. Performance

- [ ] Lighthouse Performance score >= 90 on mobile.
- [ ] Largest Contentful Paint (LCP) < 2.5s.
- [ ] Cumulative Layout Shift (CLS) < 0.1.
- [ ] First Input Delay (FID) < 100ms.
- [ ] Images are optimized (WebP/AVIF, lazy-loaded below the fold).
- [ ] JavaScript bundle is code-split; no single chunk > 200KB gzipped.
- [ ] Fonts are preloaded and use `font-display: swap`.

## 3. Security

- [ ] HTTPS enforced with valid certificate.
- [ ] Security headers set: `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`.
- [ ] No secrets or API keys in client-side code.
- [ ] Form inputs are validated server-side (not just client-side).
- [ ] Authentication tokens stored in httpOnly cookies (not localStorage).
- [ ] Rate limiting on API endpoints.

## 4. Accessibility

- [ ] All pages pass axe-core with zero critical violations.
- [ ] Keyboard navigation works for all interactive elements.
- [ ] Screen reader testing done on at least one page flow.
- [ ] Focus indicators are visible.
- [ ] Color contrast meets WCAG AA.

## 5. Error handling

- [ ] Custom 404 page exists.
- [ ] Custom 500 page exists.
- [ ] Error boundaries catch React rendering errors.
- [ ] API errors return consistent JSON shape with status codes.
- [ ] Client-side error tracking is configured (Sentry, LogRocket, etc.).

## 6. Infrastructure

- [ ] Environment variables are set in production (not hardcoded).
- [ ] Database migrations are applied.
- [ ] CDN/caching headers are configured for static assets.
- [ ] Health check endpoint exists (`/api/health`).
- [ ] Rollback plan is documented.

## Output format

After running the checklist, output a summary table:

| Section | Pass | Fail | Notes |
|---------|------|------|-------|
| SEO | X/6 | Y/6 | ... |
| Performance | ... | ... | ... |
| ... | ... | ... | ... |

Flag any **Fail** items as blockers or warnings with recommended fixes.
