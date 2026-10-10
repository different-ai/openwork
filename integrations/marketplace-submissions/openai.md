# OpenAI: public listing packet

## Route and decision

**Do not submit the current generic gateway as compliant.** Current
[Plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines#tool-independence-and-exposure)
say:

> Expose each model-callable operation as a separate tool with a clear
> description, input schema, and annotations. Do not use discovery, operation
> selection, or schema fetching with a generic executor to enable operations
> not individually exposed for review.

OpenWork's `search_capabilities`, `execute_capability` and
`execute_capability_script` enable dynamically selected operations. Conservative
annotations do not remove that mismatch. The same guidelines exclude plugins
primarily functioning as unofficial third-party connectors/pass-through layers.
These are published rules; a specific OpenWork eligibility decision is not yet
known.

The current submission route is **[Platform → Plugins](https://platform.openai.com/plugins)**.
The public universal Plugin Directory is shared by ChatGPT and Codex.
Apps SDK/MCP-backed apps are packaged and submitted as plugins; the historical
`ai-plugin.json`/OpenAPI ChatGPT-plugin route is obsolete. July 9, 2026
[release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
describe the directory replacement. Repository/personal marketplaces remain
separate distribution paths.

## Smallest credible public surface

A proposed public listing should expose a bounded **OpenWork-native Library
experience**, not arbitrary organization tools:

1. Individually named, typed operations to list/read explicitly requested
   Library items and create an additive private item. Treat retrieved text as
   user data, not automatically elevated agent instructions.
2. Reuse existing member/grant checks, storage and audit; no generic executor,
   code evaluation, arbitrary API dispatch, downstream connector management,
   admin tools, remote runners, billing or unreviewed workflow execution.
3. Never hide an executor only in `tools/list` while still accepting its
   `tools/call`. Enforce the same allowlist on every request and resource read.
4. Give each operation exact output schemas, titles, annotations and OAuth
   security declarations. Keep persistence explicitly non-read-only.
5. Start without UI. Bundled, versioned skills may teach a reviewed sequence;
   they must not use discovery as a way around individually reviewed tools.

This is an **implementation proposal, not an existing endpoint or a guarantee
of acceptance**. It needs a cloud-only registry feature, declared off before
implementation, resource/audience and least-privilege scope design, generated
API contracts, kill-switch behavior, tests and a separate reviewed code PR.
Choose its stable URL before submission: changing a published MCP URL can
require OpenAI support. Keep `/mcp/agent` unchanged for private/direct clients.

## Publisher prerequisites

- Verified business identity for the actual publisher in
  [organization settings](https://platform.openai.com/settings/organization/general).
- Intended organization and project selected; remote-MCP review currently
  requires global data residency, not an EU-residency project.
- Organization owner or `api.apps.write` / Apps Management Write permission;
  `api.apps.read` for viewing.
- Intended availability/countries and policy attestations approved by the owner.
- Dedicated populated login+password reviewer account; no inaccessible MFA,
  email/SMS code, magic link, new signup, organization setup or VPN gate.

None of these owner-specific prerequisites was verified in this preparation.

## Metadata copy

Use the existing portable package format from
[Package your plugin](https://developers.openai.com/plugins/build/plugins).
OpenAI presentation belongs in `extensions.com.openai.interface` in root
`plugin.json`. A `.codex-plugin/plugin.json` compatibility overlay is supported
but not needed for the portable format.

For a curated Library candidate, **draft copy**:

| Field | Prepared value |
| --- | --- |
| `displayName` | `OpenWork Library` (≤30 characters) |
| `shortDescription` | `Your team's reusable work` (≤30 characters) |
| `longDescription` | `Find and read reusable work saved in your OpenWork Library, and save a new private item when you ask. Access is limited to your selected workspace and the items you are allowed to use. This plugin does not execute arbitrary connections, scripts or organization administration.` |
| `developerName` | `OpenWork` — actual displayed publisher must match verified identity |
| `category` | `Productivity` |
| `websiteURL` | `https://openworklabs.com` |
| `supportURL` | `https://openworklabs.com/contact` |
| `privacyPolicyURL` | `https://openworklabs.com/privacy` |
| `termsOfServiceURL` | `https://openworklabs.com/terms` |
| `defaultPrompt` | `List the items available in my OpenWork Library.` / `Read my reviewer weekly brief.` / `Save these notes as a new private Library item.` |
| `capabilities` | `Find Library items`, `Read Library items`, `Save a private item` — only after implemented |

Do not claim these capabilities are already deployed or change the general
OpenWork Connect package's copy to pretend they are. Logos must be square,
≥48×48 and ≤5 MiB. The package needs `logo` and `composerIcon` for the Codex
format. Do not include competitive comparisons, prices, free-trial language,
checkout/upgrade promotion, fake endorsements or credentials.

## Review material

[Upload and submit](https://developers.openai.com/plugins/deploy/submission)
requires:

- **Five positive tests** and **three negative tests**, including prompt,
  expected behavior and tools triggered; the proposed cases are in
  [`review-cases.json`](review-cases.json).
- Reviewer-accessible walkthrough recording, release notes, secure account
  details and any prerequisite instructions.
- Each declared tool exercised, invalid requests handled clearly, and actual
  ChatGPT desktop/mobile and supported Codex behavior tested.
- Remote HTTPS MCP server included in the first ZIP. Adding an MCP to an
  existing skills-only plugin is not currently supported.
- One connected MCP server per submitted plugin. Public ZIPs cannot contain
  lifecycle hooks or registered-app references (`apps` / `.app.json`).
- No screenshots for a no-UI plugin. If UI is later included, validate standard
  MCP Apps bindings, CSP and a unique per-plugin UI domain separately.

The review cases are **not passing evidence** and must be mapped to implemented
operation names before upload. Current guidelines no longer require annotation
justifications, while some review/error pages still mention them; prepare
explanations and check actual portal validation.

## OAuth and domain verification

Live metadata advertises CIMD, DCR, S256, refresh tokens, a separate authorization
host and `authorization_response_iss_parameter_supported: false`.
Use the exact `resource=https://api.openworklabs.com/mcp/agent` for the current
gateway; do not use `/mcp`, the metadata URL or issuer as its audience.
A new curated endpoint needs its own reviewed resource/audience contract.

With the current false issuer-identification flag, copy callback-specific values
from the actual connection setup rather than registering guessed values:

```text
ChatGPT redirect: https://chatgpt.com/connector/oauth/{callback_id}
ChatGPT CIMD:     https://chatgpt.com/oauth/{callback_id}/client.json
Codex CIMD:       https://chatgpt.com/oauth/codex/{callback_id}/client.json
Codex redirect:   http://127.0.0.1:<port>/callback/{callback_id}
```

OpenWork's general HTTPS/loopback redirect policies appear compatible in source;
that is not a successful native OAuth test. Stable callback/CIMD values require
correct RFC 9207 issuer-bound responses; do not merely change the advertised
boolean. See [Authentication](https://developers.openai.com/plugins/build/auth).

The portal provides an exact plain-text domain-verification token for:

```text
https://<MCP-host-or-eligible-parent-host>/.well-known/openai-apps-challenge
```

Do not invent the token, include JSON, overwrite another plugin's challenge or
commit credentials. The MCP host returned 404 for that path during research;
parent-domain verification and Platform verification status remain unknown.
Use a separately reviewed deployment/route change only after the real portal
challenge is available.

## Submission sequence

1. Owner resolves the known architecture, pass-through, legal/audience and
   publisher-identity gaps.
2. Validate and ZIP the exact implemented public package.
3. Platform → Plugins → **Upload new or existing plugin**; select developer
   identity and upload ZIP.
4. Resolve Metadata & Skills validation and security scan issues.
5. MCPs → server → **Connect**; verify domain, complete actual OAuth and scan
   the exact current tools.
6. Metadata & Skills → Review information → Review details; enter private
   reviewer credentials/materials.
7. Owner reviews attestations and selects **Submit for review**.
8. After approval, separately choose **Publish plugin**. Approval is not
   publication or guaranteed featured placement.

Current submission docs describe daily hosted-server scans. New tools remain
unavailable until approved; skills/metadata/assets require a new ZIP. Do not
mutate approved tool contracts while updates are held for review.
