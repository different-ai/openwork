# Native marketplace QA handoff — 2026-10-10

**Overall readiness: Incomplete.** This records the user-supplied computer-use
agent report; these native runs were not independently repeated by the
preparation agent. Screenshot captions and named tool-evidence items were
provided, but not usable artifact links/files. Treat passes below as reported
bounded results, not a new independently verified support claim.

No application, public repository, public publication, billing change or review
email was reported. Existing accounts/connections were preserved; test objects
remain in place pending approved cleanup.

## Provenance reported by the QA agent

- Date: October 10, 2026, America/Los_Angeles; macOS 26.2 (25C56).
- Cursor 3.24.12; Claude desktop 2.31226.1; Claude Code 2.1.156;
  Codex CLI 0.162.0-alpha.17.2.
- Package PR #5850: `22a0d5a15c9b4e445139b91121cb1b7c2b135191`.
- Preparation PR #5851: `02bd83674adabdb89535e0dbd4cae766027a5524`.
- Deeper plan PR #5849: `1daf667f7911826991ddb32fec2cb31c766aefd3`;
  documentation only.
- The previously named worktrees/export were absent on the test computer. Files
  were reconstructed from pinned heads; offline checks were not a full-checkout
  validation.
- Export contained nine package files plus three catalogs. Delivered package
  ZIP SHA-256: `c41ab120cd56599d2c6d647c2091e347828a1d54bff5c249309d9467043a186b`.
  The reported desktop upload accepted the nine-file ZIP.
- Normal authorized signed-in setup created a separate synthetic QA organization
  and the exact private brief fixture. Native OAuth used normal consent, not the
  preparation agent's anonymous assertion. The owner used an existing account;
  an ordinary-member reviewer identity and maintained credentials are still
  missing.

These observations bind to the tested package version 1.0.0 and pinned heads.
Package/instruction changes require a fresh export and targeted retest; do not
reuse this ZIP hash or old behavior as proof for a later version.

## Reported results

| Surface | Installation/configuration | OAuth / fixture | Negative/recovery | Remaining |
| --- | --- | --- | --- | --- |
| Cursor desktop | Local plugin installed; one intended OpenWork connection | Normal QA consent; 14 tools/11 resources; exact capability retrieval and correct brief | Email limitation and declined consent passed; loose nonexistent-query interpretation failed; exact reader refused; reconnect passed | Refresh, server-side revocation and isolation not tested |
| Cursor Cloud Agents | Not tested | Blocked by source control/privacy-mode prerequisites | Not tested | No upgrade/source-control change authorized |
| Claude desktop chat | Uploaded plugin installed: one skill and connector | Not tested: paired with an existing connector whose workspace binding was unknown | Existing connector neither used nor disconnected | Free account could not add isolated connector |
| Claude web | Not tested | Signed out; isolated connector unavailable | Not tested | Appropriate authenticated account/role |
| Claude Cowork | Shared plugin installation reported | Blocked by account upgrade requirement | Upgrade dismissed | Eligible account; no purchase authorized |
| Claude Code | Marketplace strict validation passed; plugin installed; old plugin strict validation warned/fails | Blocked by normal account-plan/API-key prerequisite | No billing or existing-session change | Validator-version distinction and native OAuth still needed |
| ChatGPT web private MCP | Separate private custom record, not package ZIP | Normal QA OAuth and correct fixture/brief | Email limitation and exact missing-item refusal passed | Raw argument-level trace not independently certified; refresh/revoke/isolation not tested |
| Codex CLI repository plugin | Plugin installed/enabled with manual MCP disabled | Bundled read tools absent; fixture run failed; plugin OAuth not verified | Correctly declined to invent result | Package/client/auth/config root cause unresolved |
| Codex CLI direct MCP | Isolated manual server configuration | Normal MCP OAuth, model-account login, assigned fixture read and correct brief | Recognized loose search, checked exact reader and filtered catalog; missing-item refusal passed | Refresh/revoke/isolation not tested |
| Codex desktop plugin | Not tested | Not tested | Not tested | Existing desktop configuration intentionally preserved |

## Failure classification

### Cursor: discovery relevance is not exact existence

The reported search for `nonexistent-project-qa-404` returned the general brief.
Cursor described it as a matching named item instead of validating the requested
identity. The exact `get_skill` request then returned `unknown_skill`; Codex
performed that verification and a filtered `list_skills` lookup successfully.

This is a reported **client interpretation/workflow failure**, not evidence that
the exact reader fabricated a skill or that the gateway was down. Subsequent
read-only code diagnosis found additive keyword scoring: tokenization of the
query includes `project`, which overlaps the fixture description “weekly project
brief.” A synthetic local probe scored that candidate 3, while a truly
zero-overlap query scored 0. `type: skills` restricts object sources, not exact
identity; filtered list/read have different contracts. No zero-score fallback
was found in the current skill sources. The production score/deployment SHA was
not supplied, so the local calculation is an explanation, not a production
trace.

A returned loose match must not establish an exact-name existence claim. Fix
identity-verification guidance without silently changing scoring. Its effect
needs a native retest, not only a text-invariant test. `unknown_skill` means the
reference is unavailable to this caller, not globally nonexistent.

The first unconstrained Cursor prompt reportedly stalled in tool exploration for
about eight minutes and was stopped. Keep it failed/incomplete; no layer-level
trace was supplied to attribute the stall to the gateway.

### Claude: strict validator versus runtime

Reported strict error on 2.1.156: `icon: Unknown field 'icon'`; installation still
succeeded. Current official
[manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference#directory-listing-fields)
explicitly says directory fields including `icon` are accepted without warning
only on **2.1.281+**; older clients strip unknown top-level fields at load and
strict mode turns the warning into a failure. Preparation validation used
2.1.284.

Therefore this is a **documented validator-version incompatibility**, not proof
that the plugin failed to load. Use 2.1.281+ for full MCP/directory-field strict
validation or deliberately produce a legacy metadata variant. Do not remove
listing metadata blindly or call old-version strict validation passed. The older
CLI's account prerequisite independently blocked its OAuth/runtime test.

### Codex: installed package did not expose MCP tools

The alpha CLI installed version 1.0.0, but its plugin-only run exposed neither
allowed reader. Direct MCP in another isolated profile worked. Plugin-specific
OAuth was never verified. The report does not include resolved runtime MCP
inventory, plugin server identifier, exact configuration/tool-filter keys or a
startup/auth failure trace.

Root cause remains **unresolved**, not a gateway outage and not yet a justified
manifest fix. Subsequent read-only diagnosis pinned the official alpha tag to
source commit `740e5af33c71225640e0c1c1555c514c2c93ab74` and found:

- Root portable manifests and `streamable-http` bundled servers are supported;
  installation does not start OAuth.
- A manual/config server outranks a plugin server with the same raw name,
  **even when the manual entry is disabled**. If the QA profile retained a
  disabled `mcp_servers.openwork`, that can shadow the bundled server. The safe
  fields of the actual QA configuration were not supplied, so this is a
  concrete conditional hypothesis, not a diagnosed cause.
- Plugin server filters use raw names `list_skills`/`get_skill`; incorrect
  nesting or generated tool names can filter out both.
- MCP tools can be deferred behind native tool search. Missing initial model
  declarations alone does not prove missing runtime registration.
- This alpha's portable server parser rejects newer per-server auth extensions
  described by current docs; adding one blindly could break the existing file.

Sources: [registration precedence](https://github.com/openai/codex/blob/740e5af33c71225640e0c1c1555c514c2c93ab74/codex-rs/codex-mcp/src/catalog.rs),
[portable parser](https://github.com/openai/codex/blob/740e5af33c71225640e0c1c1555c514c2c93ab74/codex-rs/codex-mcp/src/agent_plugin_config.rs),
[tool filtering](https://github.com/openai/codex/blob/740e5af33c71225640e0c1c1555c514c2c93ab74/codex-rs/codex-mcp/src/tools.rs).

Follow the [targeted retest](../native-retest.md) in one consistent isolated
context, with no same-name manual registration. Verify bundled loading, policy,
OAuth and runtime inventory before a model prompt. Do not enable the manual
entry as a workaround, copy credentials or credit the direct profile's success
to the bundle.

### Recovery is not revocation proof

Cursor local logout briefly displayed a rate-limit message and then reached
Needs Authentication after reload. Consent cancellation left it unauthorized;
normal reauthorization restored the QA catalog. This proves bounded UI recovery
and reconnect, not rejection of a previously issued server token. No raw network
capture/layer identification was supplied; do not assign a rate-limit root cause
or claim refresh, rotation, revocation or isolation passed.

## Offline/public checks reported

- Packaging: 19 tests passed; nine package files/three catalogs validated.
- Preparation helpers: 99 tests passed.
- Public preflight at 19:50:30 UTC passed challenge/discovery, active registry and
  three public-page checks. Initial network-permission failures cleared after
  permission and were not classified as service failures.
- Older Claude marketplace strict validation passed; older plugin strict
  validation failed as documented above. Installation and validation are
  distinct verdicts.

## Portal inspection and next gates

- Cursor's signed-in publisher fields matched the packet. The owner/namespace,
  contact, standalone public repository, background-plate logo, pricing/legal
  disclosures and maintained reviewer identity remain unresolved. No terms or
  submission accepted.
- Community directory reached sign-in; authenticated form/scan was not tested.
- Claude directory browser was signed out, desktop account ineligible for the
  needed isolated flows. Submission role and signed-in form remain unverified.
- ChatGPT's private custom MCP workflow passed bounded QA, not a ZIP or public
  directory test. OpenAI Plugins upload entry was visible, but the selected
  project was explicitly unsuitable; nothing was uploaded or changed. Identity,
  domain, project and review checks remain unverified.
- OpenAI generic-executor restrictions and Claude's mixed-operation,
  proxy-permission/dynamic-instruction concerns are unchanged by these runs.

Retest only the remaining/failing paths on an eligible approved account; finish
refresh, server-side revocation and a second isolated tenant; collect sanitized
artifact links and exact package runtime diagnostics. Keep public **Setup only**
labels until the support definition and evidence are satisfied.

## Cleanup boundary

The signed-in QA organization/fixture, local client package, uploaded desktop
plugin, isolated CLI profiles, private ChatGPT record/conversation and export
were reported left in place. Test credentials are in the test agent's isolated
area, not this repository. Request explicit cleanup approval and identify only
new objects before deletion/disconnection. Never reset unrelated profiles,
production workspaces or existing connectors.
