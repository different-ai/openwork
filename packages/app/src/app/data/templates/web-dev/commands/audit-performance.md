---
name: audit-performance
description: Analyze site performance and propose concrete improvements
---

Run a performance audit on this project.

Steps:
1. Identify the framework and build system (Next.js, Vite, etc.).
2. Check `package.json` for heavy dependencies (moment.js, lodash full import, etc.).
3. Look for common performance issues:
   - Unoptimized images (no `next/image`, missing dimensions)
   - Missing code splitting (large single bundles)
   - Render-blocking CSS or JS
   - Unused CSS/JS imports
   - Missing `loading.tsx` or `Suspense` boundaries
   - Client Components that could be Server Components
4. Check for caching headers in API routes or middleware.
5. Review font loading strategy.

Output a report with:
- **Score**: estimated Lighthouse Performance score (Low / Medium / High)
- **Critical issues**: things that must be fixed (with file paths and line numbers)
- **Quick wins**: easy improvements with high impact
- **Nice to have**: optimizations for later

For each issue, provide the exact code change needed. Use diff format when modifying existing files.
