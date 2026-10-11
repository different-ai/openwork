# Claude: connector and plugin listing packets

## Two applications, not one

Submit at **[claude.ai/directory/manage](https://claude.ai/directory/manage)**:

- **Submit new → MCP connector** for the remote gateway URL.
- **Submit new → Plugin bundle** for the GitHub-hosted package.

The old Console form is no longer supported. The directory portal does not
itself place the package in `claude-plugins-official`; that is a separate
curated partner path. The community repository is a read-only mirror, not a PR
submission route.

A paid Pro/Max/Team/Enterprise Claude plan is required. Team/Enterprise
submission needs the Owner role; Enterprise can delegate Directory permission
through a custom role. Choose the intended owning organization before applying.
These account/role prerequisites have not been verified.

Sources: [Publish to the directory](https://claude.com/docs/directory/publish),
[Code plugin distribution](https://code.claude.com/docs/en/plugins/publish).

## Architecture preflight before acknowledgments

The [connector review criteria](https://claude.com/docs/connectors/building/review-criteria)
and [Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy)
raise three issues with the current gateway:

1. `execute_capability` and script execution can mix reads with arbitrary
   writes. The criteria reject mixed safe/unsafe catch-all tools; marking the
   executor destructive is not documented as an exception.
2. User-added MCPs and third-party API proxying require documented permission
   and enforceable boundaries. A benign reviewer organization cannot prove the
   general endpoint excludes prohibited capabilities after listing.
3. Tools/instructions encouraging dynamic retrieval of behavioral instructions
   need explicit review. The gateway asks agents to load and follow remote
   SKILL.md content. Returning a user-requested document as data is not the same
   as allowing arbitrary fetched instructions to control the host.

**No blanket aggregator ban was found.** Existing gateway-like directory
entries are precedents, not approval for OpenWork. Send the unsent draft in
[`preflight-emails.md`](preflight-emails.md) to `mcp-review@anthropic.com`
after owner approval. If needed, ship a bounded directory surface and keep
advanced organization-specific access as a separate custom connector, a pattern
Anthropic documents in
[Directory versus custom connectors](https://claude.com/docs/connectors/building/directory-vs-custom).

## MCP connector: documented form fields

These come from the public
[submission walkthrough](https://claude.com/docs/connectors/building/submission),
not a completed authenticated application.

| Section | Prepared input / remaining choice |
| --- | --- |
| Connection | Universal URL: `https://api.openworklabs.com/mcp/agent` **only if architecture accepted**; otherwise the implemented curated URL. |
| Tools | Scan actual tools/prompts/resources; resolve titles, read/write warnings and annotations; test every exposed tool. |
| Name | `OpenWork` (≤100 characters; do not append “MCP Server”). |
| One-liner | `Use the reusable work and connected tools assigned to you in your OpenWork workspace.` (≤200; narrow if the submitted surface is narrowed). |
| Description | `OpenWork gives members access to the reusable work and tools their organization has assigned to them. Sign in, choose your workspace, and request a specific outcome. OpenWork applies workspace membership and grants before exposing or executing a capability. Availability depends on your assigned items and configured connections.` (≤2,000). |
| Categories | 1–5 actual portal categories; prefer productivity/workflow categories available there. Do not invent category identifiers. |
| Documentation | `https://openworklabs.com/docs/start-here/connect-openwork-mcp` |
| Privacy | `https://openworklabs.com/privacy` — resolve gateway/retention discrepancies before attesting. |
| Support | `team@openworklabs.com`, public support page `https://openworklabs.com/contact` |
| Icon | Versioned OpenWork mark from the plugin export; validate actual portal requirements. |
| Listing slug | Proposed `openwork`; owner must confirm availability and permanence. |
| Use cases | Find assigned reusable work; retrieve a requested item; use an explicitly configured capability. These are candidate outcomes, not a passing test claim. |
| Prerequisites | OpenWork account and workspace membership; assigned items; downstream setup if the declared scenario actually requires it. No undisclosed reviewer setup. |
| Company | OpenWork; website `https://openworklabs.com`; primary review contact supplied privately by the owner. |
| Authentication | OAuth CIMD/DCR; no static token or secret embedded in a manifest. |
| Data handling | Own OpenWork API plus authorized downstream APIs where applicable; accurately choose the proxied/third-party option, not “first-party only” for a generic relay. |
| Test & launch | Dedicated populated reviewer account, access/setup instructions, ≥3 tested prompts; each exposed tool tested. |
| Compliance | Seven acknowledgments covering directory guidelines, first-party API usage, financial transactions, AI media, prompt injection, conversation data and public docs. Owner must read actual wording. |

Do not mark health-data/sponsored-content/prohibited-operation answers false
without checking the **entire enforced endpoint**, including user-added tools.

## OAuth checks

[Authentication requirements](https://claude.com/docs/connectors/building/authentication):

- Public 401 + Bearer `resource_metadata`; exact resource URL; first advertised
  authorization server used by Claude; public metadata; PKCE S256.
- CIMD requires advertised support and token endpoint auth method `none`.
- Hosted callback: `https://claude.ai/api/mcp/auth_callback`.
- Code separately uses `http://localhost:<port>/callback` and
  `http://127.0.0.1:<port>/callback`. Hosted OAuth credentials do not solve Code.
- Token endpoint accepts form-encoded requests. Discovery/registration/token
  requests must complete within 10 seconds; refresh within 30 seconds.
- Public-client refresh rotation/sender constraints and `invalid_grant` failure
  handling; actual refresh and revoke tests still needed.
- Anthropic-held client credentials/custom authentication need coordination with
  `mcp-review@anthropic.com`; static headers are limited beta, not the plan.

The public challenge/discovery works in the live preflight. Source contains
Claude CIMD grant filtering and loopback-port handling. Neither is evidence of a
successful native-Claude OAuth round trip.

## Tool review

- Titles, descriptions, accurate annotations; names ≤64 characters.
- Separate reads from mutations and preferably create/update/delete; freeform
  request tools need target API documentation and architecture acceptance.
- Review Claude's stronger mutation/destructive checklist wording against the
  actual additive/immutable operation; do not blindly rewrite annotations on
  the general gateway to pass a scan.
- Useful invalid-request/auth/permission errors, bounded payloads and token use.
- No unnecessary conversation, memory, history or upload extraction.
- No prohibited financial transfers, standalone AI media generation or
  advertising routes without explicit permission.
- Streamable HTTP preferred; SSE is legacy.

## Plugin bundle

[Plugin submission](https://claude.com/docs/plugins/submit) and
[checklist](https://claude.com/docs/plugins/pre-submission-checklist):

- Use a small GitHub repository exported from the compatibility package; do not
  assume a small subfolder exempts the OpenWork monorepo from repository-wide
  archive limits (50 MiB archive, 256 MiB unpacked, fewer than 10,000 entries).
- `.claude-plugin/plugin.json`, root `.mcp.json`, shared skills, README ≥40 words
  excluding code, license and readable source. No secrets, symlinks, submodules,
  LFS pointers, binary launchers or unpinned install dependencies.
- GitHub connection in the intended Claude organization; connected user needs
  push access. Repository must be public before publication.
- Form asks repository, optional plugin path/ref, derived listing, data
  handling/retention/under-18 audience, private contact, four acknowledgments,
  webhook versus scheduled checks, and auto-publication preference.
- A clean scan is not publication. Follow the assigned review/publish setting.
- Use **Claude Code 2.1.281+** for strict directory-field/MCP validation. The
  [manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference#directory-listing-fields)
  documents that earlier validators warn on `icon` and other listing fields,
  so strict mode fails even though the runtime strips them and installs. The QA
  report on 2.1.156 showed exactly that distinction. Installation does not prove
  the isolated connector or OAuth worked; account/binding prerequisites blocked
  those tests.

Skills are portable across chat/Cowork/Code. Commands become skills in chat;
agents/hooks are ignored there. Local command MCP and top-level executable
components have additional platform limits. Do not claim all components work on
all surfaces; [platform matrix](https://claude.com/docs/plugins/platform-support).

## UI and launch

The urgent packet is text-first. If an MCP App is actually included, provide
3–5 PNGs at least 1,000px wide, cropped to the response, plus prompt text;
no videos/GIFs as substitute screenshots. Verify standard resource bindings,
resource proxy authorization, CSP, theme, mobile and text fallback. Claude Code
is text-only. Returning OpenWork's private app-launch envelope does not prove
Claude renders the app.

After review, publish through the portal and verify the real public listing.
Record the receipt privately; do not call a custom install link a directory
listing.
