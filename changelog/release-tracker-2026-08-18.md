# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.27

#### Commit
`802906bfaa2fbf5347076bd8ac404a5623b7374f`

#### Released at
`2026-08-17T19:28:29Z`

#### Title
Safer organization setup and signed Windows releases

#### One-line summary
Adds private-admin organization bootstrap, public cloud deployment guidance, stronger Okta setup, and signed Windows builds.

#### Main changes
- Added the initial private-admin bootstrap flow for Den organizations.
- Added public cloud deployment guides and improved Okta SSO/SCIM setup.
- Windows builds are signed by default, and Sentry events now include the app version.

#### Lines of code changed since previous release
61026 lines changed since `v0.18.26` (60881 insertions, 145 deletions).

#### Release importance
Major release: improves organization provisioning, enterprise identity setup, and Windows release trust.

#### Major improvements
True

#### Number of major improvements
3

#### Major improvement details
- Added private-admin bootstrap for Den organizations.
- Added public cloud deployment guides and improved Okta SSO/SCIM setup.
- Enabled default signing for Windows builds.

#### Major bugs resolved
True

#### Number of major bugs resolved
1

#### Major bug fix details
- Added the app version to Sentry events for more actionable desktop diagnostics.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.18.28

#### Commit
`ecf5549afdb77d6cf1ce8d84d37363cbfa12f1f5`

#### Released at
`2026-08-18T00:00:39Z`

#### Title
Connections move into the Library

#### One-line summary
Unifies Library and composer Connections while laying the foundation for private native MCP App hosting.

#### Main changes
- Library and composer Connections now share one consistent experience for discovering and using organization capabilities.
- Added the foundation for hosting native MCP Apps in the desktop's private host.
- Improved Code Mode routing, public API proxying, and MCP synchronization reliability.

#### Lines of code changed since previous release
5993 lines changed since `v0.18.27` (4860 insertions, 1133 deletions).

#### Release importance
Major release: unifies capability discovery and adds the private MCP App host foundation.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Unified Library and composer Connections.
- Added the foundation for a private native MCP App host.

#### Major bugs resolved
True

#### Number of major bugs resolved
1

#### Major bug fix details
- Improved Code Mode, public API proxying, and MCP synchronization reliability.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.18.29

#### Commit
`7043a8c292f4e86a67be40c8c90cb603740d129a`

#### Released at
`2026-08-18T19:09:00Z`

#### Title
SSO setup respects verified domains

#### One-line summary
Gates SSO configuration on domain verification and adds the Okta SAML callback setup path.

#### Main changes
- SSO configuration is now gated on domain verification.
- Added the Okta SAML callback configuration and setup documentation.

#### Lines of code changed since previous release
24135 lines changed since `v0.18.28` (18266 insertions, 5869 deletions).

#### Release importance
Minor release: hardens enterprise identity setup with focused SSO validation and documentation.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
True

#### Number of major bugs resolved
2

#### Major bug fix details
- Prevented SSO from being enabled before the organization's domain is verified.
- Added the missing Okta SAML callback configuration path.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.18.30

#### Commit
`50935ba1f696812c53930f9ef76b467c4e7d144c`

#### Released at
`2026-08-18T20:57:03Z`

#### Title
Queue follow-ups and simplify the session workspace

#### One-line summary
Makes queued follow-up messages run sequentially, streamlines the model picker and sidebar, and strengthens release validation.

#### Main changes
- Follow-up messages now run sequentially, so queued work stays ordered instead of competing with the active turn.
- The model picker is more compact and the session sidebar is denser, leaving more room for the conversation.
- Improved E2E test coverage, LiteLLM provider evidence, and runtime failure handling make releases easier to validate.

#### Lines of code changed since previous release
4147 lines changed since `v0.18.29` (3158 insertions, 989 deletions).

#### Release importance
Minor release: improves the core session workflow and release validation without changing the product model.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Added sequential execution for queued follow-up messages.

#### Major bugs resolved
True

#### Number of major bugs resolved
2

#### Major bug fix details
- Simplified model and sidebar controls to preserve conversation space.
- Hardened E2E and LiteLLM provider validation plus expected runtime failure handling.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.
