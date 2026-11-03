# Library UX and connector catalog handoff

Branch: `feat/library-ux`. This is unfinished work, not a release-ready claim.

## Completed here

- Grouped Library and Manage Connectors, aligned 44px rows on one white surface; 24px icon slots for every kind.
- Name filter only when total items >10 (or an active query). No repeated healthy summary.
- Readable skill page and connector OAuth pending/slow/failure screens.
- Native Google setup recovery and fixed internal return-to-origin links.
- My agent renamed My bot, moved to Work sidebar at `/dashboard/my-bot`; legacy route redirects.
- Removed temporary Library/sign-in flags, per current repo guidance. The requested expanded MCP catalog is different: user explicitly requests a default-off flag.

## Known issues / verification still needed

- User reports runtime failure at `myBot: myAgentAvailable(orgContext)` in org-dashboard-shell.tsx. Typecheck passed and a fresh screenshot worked, but hot reload produced ReferenceErrors during edits. Investigate cold boot, imports, module cycles and command-palette path rather than assuming cache. Prefer a lightweight availability predicate rather than importing the whole MyAgentScreen module into the shell.
- Existing `myAgentAvailable` still uses the existing workbotProactive + workbotAgentLibrary availability conditions. Preserve these.
- Local-only preview override in worlds/lib/preview.ts was deliberately NOT committed: it pointed at a nonexistent loopback Workbot URL to show the UI. Do NOT reproduce fake readiness. Real Workbot preview failed gateway_not_configured; bot execution and delivery have NOT been proven.
- Last local e2e proof passed 1/1 (no skips) before the latest white surfaces, icons and My bot move. Rerun updated proof and add navigation coverage.
- Web typecheck/lint and 26 affected web unit tests passed after My bot move; 33 API proactive unit tests passed. API integration test not run.
- SkillInstructions is a deliberately small custom Markdown renderer; consider replacing with an existing supported renderer if available. Not full Markdown compliance.
- Check attention, mobile/touch menu, filtered empty, loading/error states; not all were exercised.

## Requested next task: more well-known official MCP presets, behind a flag

User wants a much larger Add a connector list and to try a few before rollout. Declare default-off registry flag BEFORE implementing. Preserve the existing 11 presets with flag off; gate new additions only and do not break existing saved connections when switched off. Follow repository skills and generate contracts/SDK if registry/routes require it. Do not auto-connect or authorize accounts.

Existing catalog: ee/apps/den-api/src/capability-sources/external-mcp-presets.ts, consumed by routes/org/mcp-connections.ts and mcp/connector-catalog.ts. Existing automatic CIMD and DCR support is in packages/enterprise-mcp-client/src/oauth-provider.ts. Do not invent another auth path.

Read-only public endpoint probes advertised CIMD at the following candidates (NOT end-to-end OAuth proof; verify official docs and ownership again before adding):

- Airtable https://mcp.airtable.com/mcp
- Amplitude https://mcp.amplitude.com/mcp
- Canva https://mcp.canva.com/mcp
- Fireflies https://api.fireflies.ai/mcp
- Hugging Face https://huggingface.co/mcp
- Lucid https://mcp.lucid.app/mcp
- Mural https://mcp-canvas.mural.co/mcp
- Vercel https://mcp.vercel.com
- PostHog https://mcp.posthog.com/mcp
- monday.com https://mcp.monday.com/mcp
- Tavily https://mcp.tavily.com/mcp
- Honeycomb https://mcp.honeycomb.io/mcp
- Klaviyo https://mcp.klaviyo.com/mcp
- Semgrep https://mcp.semgrep.ai/mcp
- Cal.com https://mcp.cal.com/mcp

Official MCP registry snapshot also contained Atlassian, CircleCI, Close, Cloudflare and Figma (DCR advertised). Registry is not exhaustive: several major vendors host MCP servers not listed there. DCR/CIMD advertisement is not proof a provider accepts OpenWork. No real account authorizations were performed. Do not assert that all listed brands connect without setup or approved-client constraints. Avoid indiscriminately importing thousands of unreviewed third-party endpoints.

Implement reviewed additional presets with real brand marks and clear auth/setup states, verify existing off path and enabled catalog, and provide a real Mac Studio preview with flag enabled only for its disposable org. Ask user to take over OAuth for selected providers; do not enter credentials or bypass sign-in restrictions.
