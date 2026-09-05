# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.31

#### Commit
`a9c304f3`

#### Released at
`2026-08-19T00:32:39Z`

#### Title
Enterprise identity records stay valid

#### One-line summary
Keeps linked SSO and SCIM account IDs valid while making release validation faster and easier to diagnose.

#### Main changes
- Fixed linked enterprise identity accounts so their IDs always use the required TypeID format.
- Strengthened SSO-before-SCIM lifecycle validation.
- Made release checks faster and improved alerts when extended tests fail.

#### Lines of code changed since previous release
1294 lines changed since `v0.18.30` (937 insertions, 357 deletions).

#### Release importance
Minor release: hardens enterprise identity records and improves release validation.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Made release validation faster and improved extended-test failure alerts.

#### Major bugs resolved
True

#### Number of major bugs resolved
1

#### Major bug fix details
- Enforced valid TypeIDs for linked SSO and SCIM accounts.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.18.32

#### Commit
`ab878c31`

#### Released at
`2026-08-19T07:18:19Z`

#### Title
Workspace imports and SAML replay protection get safer

#### One-line summary
Bounds workspace archive expansion and keeps SAML replay reservations compatible with stored identity records.

#### Main changes
- Workspace imports now reject archives that expand beyond safe file-count or size limits.
- Fixed SAML replay reservations so their identifiers remain compatible with the identity database.
- Clarified how to validate a live Okta SCIM setup.

#### Lines of code changed since previous release
258 lines changed since `v0.18.31` (161 insertions, 97 deletions).

#### Release importance
Minor release: closes focused safety and enterprise identity reliability gaps.

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
- Bounded workspace archive decompression by file count and expanded size.
- Made SAML replay reservation IDs compatible with the identity database.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.18.33

#### Commit
`86e727e8`

#### Released at
`2026-08-19T13:48:15Z`

#### Title
Library setup gets clearer and background connections recover cleanly

#### One-line summary
Adds a clearer Library item picker, makes Desktop automations recover from credential failures, and bounds background cloud requests.

#### Main changes
- The Library Add flow now presents clear item-type choices before setup begins.
- Desktop automations recover rejected credentials and back off repeated reconnect failures.
- Cloud MCP health probes and GitHub token requests now have strict request budgets.
- Added a Google Cloud deployment prompt and stronger OpenCode MCP OAuth validation.
- Repaired npm publishing so releases can complete reliably.

#### Lines of code changed since previous release
10820 lines changed since `v0.18.32` (7023 insertions, 3797 deletions).

#### Release importance
Major release: improves Library setup, automation recovery, cloud request resilience, and release reliability.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Added a clear item-type picker to the Library Add flow.
- Added a Google Cloud deployment prompt and stronger OpenCode MCP OAuth validation.

#### Major bugs resolved
True

#### Number of major bugs resolved
4

#### Major bug fix details
- Recovered Desktop automations after rejected credentials.
- Added backoff for repeated Desktop automation reconnect failures.
- Bounded cloud MCP health probes and GitHub token requests.
- Repaired npm publishing for stable and recovery releases.

#### Deprecated features
True

#### Number of deprecated features
1

#### Deprecated details
- Standardized end-to-end test and evidence terminology and retired legacy names.
