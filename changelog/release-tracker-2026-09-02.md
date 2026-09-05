# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.41

#### Commit
`eb687539`

#### Released at
`2026-09-02T01:52:38Z`

#### Title
Session status gets honest and cloud providers connect with saved credentials

#### One-line summary
Makes Working indicators and session reconciliation truthful, connects Den providers from locally saved Desktop credentials, and publishes SOC 2 Type I status.

#### Main changes
- Working indicators now stop when a run errors or the engine is unreachable, and show minutes past the first hour.
- Sessions reconcile more cleanly: completions are detected while you are elsewhere, queued composer messages send when a session is out of view, and archiving works from any workspace.
- Den cloud providers now connect using credentials saved locally on the Desktop, and Google Workspace retrieval is more resilient.
- The landing page shows OpenWork's SOC 2 Type I badge and status, and web boot failures and Stripe webhook errors now reach Sentry.
- Remediated static-analysis security findings, isolated provider sync contexts, and improved internal test and release tooling.

#### Lines of code changed since previous release
25270 lines changed since `v0.18.40` (18863 insertions, 6407 deletions).

#### Release importance
Minor release: reliability fixes to session status and reconciliation, plus saved-credential provider connections and SOC 2 Type I disclosure.

#### Major improvements
True

#### Number of major improvements
3

#### Major improvement details
- Connected Den cloud providers from locally saved Desktop credentials.
- Published the SOC 2 Type I badge and status on the landing page.
- Reported web boot failures and Stripe webhook errors to Sentry.

#### Major bugs resolved
True

#### Number of major bugs resolved
4

#### Major bug fix details
- Stopped Working indicators from ticking after errors or while the engine is unreachable.
- Reconciled active session completion, queued composer drains, and coalesced workspace session loads.
- Fixed archiving sessions from non-selected workspaces.
- Isolated provider sync contexts and hardened Google Workspace retrieval.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.18.42

#### Commit
`1785d362`

#### Released at
`2026-09-02T21:35:32Z`

#### Title
MCP connections become standard servers and desktop flows stay reliable

#### One-line summary
Exposes MCP connections as standard MCP servers while improving browser opening, dashboard discovery, Settings navigation, and enterprise sign-in validation.

#### Main changes
- MCP connections can now be exposed directly as standard MCP servers.
- Fixed browser.open_url so a blank initialize load no longer aborts it.
- Added the OpenWork Dashboard page and interactive dashboard preview, plus a Dashboards guide with an MCP App widget tutorial.
- Improved narrow-window Settings navigation, session naming, child permission requests, image lightboxes, tool groups, queued drafts, and session sidebar behavior.
- Added Automations flags to Helm starter examples, Google SSO and SCIM guidance, and safer SSO configuration validation.

#### Lines of code changed since previous release
30372 lines changed since `v0.18.41` (29924 insertions, 448 deletions).

#### Release importance
Minor release: adds direct MCP server exposure and dashboard discovery while resolving desktop, session, and SSO reliability issues.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Exposed an MCP connection directly as a standard MCP server.
- Added the OpenWork Dashboard page, interactive dashboard preview, and Dashboards guide.

#### Major bugs resolved
True

#### Number of major bugs resolved
4

#### Major bug fix details
- Stopped a blank initialize load from aborting browser.open_url.
- Kept a way out of Settings in narrow windows and kept binary file paths out of Read-expanded prompt parts.
- Hid subagent sessions when their parent is archived or unloaded, and surfaced child permission requests in parent tasks.
- Fixed image lightbox sizing, tool-group detail visibility, queued follow-up draft wrapping, and the OpenWork system prompt message structure.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.
