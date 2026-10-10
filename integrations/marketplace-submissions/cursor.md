# Cursor: first-listing application packet

## Routes

- **Official curated marketplace:** [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish).
- **Separate community directory:** [cursor.directory/plugins/new](https://cursor.directory/plugins/new).
- Immediate direct install: the existing OpenWork MCP install link/configuration
  in [Connect OpenWork](https://openworklabs.com/docs/start-here/connect-openwork-mcp).

The old standalone `cursor/mcp-servers` repository is archived; do not open a new
listing PR there. Community approval does not propagate into the official
marketplace. September 2026 Cursor staff
[confirmed the distinction](https://forum.cursor.com/t/cursor-marketplace-submission/170458/6).

## Why prioritize this route

[Current Cursor plugin docs](https://cursor.com/docs/reference/plugins) support
both the existing root Agent Plugins `plugin.json` package and native
`.cursor-plugin/plugin.json` bundles. Portable skills + remote MCP are enough;
rules, agents, commands, hooks and modes are optional, not listing prerequisites.

No public Cursor-specific prohibition on a generic gateway or mixed executor
was established. Current official listings include
[Executor](https://cursor.com/marketplace/usefulsoftwareco),
[Kody](https://cursor.com/marketplace/kody) and
[Treg](https://cursor.com/marketplace/superdesign/treg).
These are precedents, **not** promised acceptance or proof of our OAuth behavior.

## Official publisher form

The sign-in-gated public application's delivered client code was inspected
read-only during research. Recheck the actual authenticated form before entry.

| Field | Prepared copy / status |
| --- | --- |
| Organization name | `OpenWork` |
| Organization handle | Proposed `openwork`; confirm availability. Required namespace. |
| Contact email | Proposed public support inbox `team@openworklabs.com`; owner confirms it is monitored for review mail. |
| Logotype URL | `https://openworklabs.com/openwork-mark.svg`; confirm a 1:1 SVG/PNG with background plate as requested by the form. Do not assume the bare mark meets the visual requirement. |
| Description | `Use the reusable work, workflows and connected tools assigned to you in your OpenWork workspace through one OAuth connection.` |
| GitHub repository | Public **repository-root** URL for the exported standalone package, chosen and created by the authorized owner. The application expects `https://github.com/<org>/<repo>`, not a tree/subfolder URL. |
| Owner | Derived from the signed-in individual/team, not a text value to invent. |
| Website URL | `https://openworklabs.com` |
| Submission | Accepts Publisher Terms; requires owner approval, not just a valid package. |

The public publisher application does not contain OAuth/reviewer-credential
fields. Reviewers can still request access later. Keep a populated reviewer
workspace and native OAuth proof ready.

## Repository checklist

- Valid root Agent Plugin or native Cursor manifest; unique lowercase name.
- Small permissively licensed wrapper, readable source, version, committed logo,
  README with usage/configuration, valid relative component paths.
- No binaries, launchers, embedded tokens or secret values. OAuth needs no
  placeholder API key or plugin variable.
- A monorepo with multiple plugins uses root `.cursor-plugin/marketplace.json`.
  Do not submit the entire OpenWork app archive when the small wrapper suffices.
- Local package load and actual MCP auth/tool use tested before applying.
- Manual review applies to every published update; no guaranteed SLA/placement.

[Marketplace security](https://cursor.com/help/security-and-privacy/marketplace-security)
and [Publisher Terms](https://cursor.com/marketplace-publisher-terms) require
open-source plugins, permissive licenses, accurate disclosures, user support and
maintenance. The wrapper is MIT; do not bundle Enterprise Edition backend code
or imply that the gateway's entire backend is licensed like the wrapper.

**Pricing needs clarification:** terms prohibit direct/indirect charging for
marketplace-plugin access while current listings can use paid services. Ask
`marketplace-publishing@cursor.com` how existing OpenWork paid-account
entitlements fit; do not infer an exemption from other listings. The plugin
itself must not add an install charge or unexpected fee. Prepared unsent email:
[`preflight-emails.md`](preflight-emails.md).

## Runtime checks

Cursor [MCP documentation](https://cursor.com/docs/mcp) supports Streamable HTTP,
OAuth and DCR. Current documented callbacks include:

```text
Desktop: http://localhost:8787/callback
Web/Agents: https://www.cursor.com/agents/mcp/oauth/callback
```

OpenWork source also retains an exact native
`cursor://anysphere.cursor-mcp/oauth/callback` compatibility exception; do not
assume that exception verifies current desktop or Cloud Agent behavior.

Test desktop and web/Cloud Agent paths separately: sign-in, consent, selected
workspace, positive fixture, invalid request, refresh, revocation and denied
cross-workspace access. The synthetic assertion/token preflight does not test
Cursor's user-OAuth client.

A one-click install URL may prefill a single server configuration, but must not
contain credentials or change unrelated servers. It is not store approval:
[Install links](https://cursor.com/docs/mcp/install-links).

## Community-directory submission

Sign in and use Auto (GitHub) or Manual mode. Public source currently documents:

- Name ≥2 characters and description ≥10.
- Optional logo, repo/homepage URLs and keywords.
- At least one named component; choose MCP server and optionally the bundled
  skill; include the actual configuration/content.
- Scan the repository, inspect detected files and edit before publication.
- Submitted entries initially await community review.

The deployed page encountered a security checkpoint, so its precise live
form/review behavior is unverified. Repository source is not proof the deployed
form is unchanged. Do not bypass the checkpoint.

Sources: [community form](https://github.com/gokimedia/cursor-directory/blob/main/apps/cursor/src/components/forms/plugin-form.tsx),
[submission schema](https://github.com/gokimedia/cursor-directory/blob/main/apps/cursor/src/actions/create-plugin.ts).

## Definition of done

Native tests documented; intended owner/contact/repository confirmed; publisher
terms reviewed; official application submitted with receipt; follow-up questions
answered; actual official listing verified. Track the community listing
separately. None of those submission/approval steps has been completed by this
packet.
