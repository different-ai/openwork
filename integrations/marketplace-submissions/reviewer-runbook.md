# Reviewer workspace and proof runbook

## Prepared versus still needed

**Prepared:** a synthetic `reviewer-weekly-brief` fixture, a reproducible
preflight, and one live isolated provisional QA workspace. Its token exchange,
MCP initialization, tool catalog, skill creation/list/read and capability
search/retrieval were verified. This does **not** verify model behavior or any
native-client OAuth flow.

**Still needed:** a real company-controlled reviewer login and durable
workspace. The anonymous QA workspace expires after 72 hours and cannot serve
as an immediate login+password reviewer account. No permanent email-backed
account was created: inbox ownership/verification cannot be invented.

## Durable account preparation

1. Owner designates an existing reviewer identity or a real controlled inbox
   that can complete normal signup/verification. Use normal auth; never disable
   production verification, MFA policy, membership checks or token validation.
2. Provision a separate durable organization. A human owner/admin sets it up;
   the reviewer should be an ordinary member with only submitted capabilities.
   No platform-admin role, production organization, billing, API keys, customer
   marketplace access, personal inbox/calendar or real outgoing messaging.
3. Assign the exact reviewed Library items and workflows. Seed this fixture and
   any other sample data required by each listed tool. Do not rely on an empty
   signup or on manifests that merely describe unconnected services.
4. If a submitted operation needs a downstream provider, use a dedicated
   permitted sandbox integration containing only synthetic data, fully connected
   ahead of review. Do not use the reviewer's own mail or a team's production
   Slack. A synthetic server is acceptable QA but must not masquerade as the
   production connector or establish production-functionality claims.
5. Check actual plan entitlements and grants. Do not grant enterprise access or
   enable organization features solely to conceal a missing public flow. The
   declared use cases must describe real prerequisites.
6. Test the username/password in a clean browser with no private preview cookie,
   MFA device approval, email code, magic link, VPN or fresh setup requirement.
   Resolve account policy with the owner rather than bypassing it.
7. Store password, login URL, selected organization, permissions and reset
   instructions in the company's secret manager/secure portal fields. Do not
   paste them into issue comments, PRs, archives, recordings or this runbook.
8. Keep the account maintained throughout review. Reset synthetic mutations
   between runs; rotate credentials and revoke OAuth grants after review or if
   exposed. Retain any real listing receipt privately.

## Synthetic fixture contract

Source: [`fixtures/reviewer-weekly-brief/SKILL.md`](fixtures/reviewer-weekly-brief/SKILL.md).

Expected brief:

- **Completed:** documentation refresh.
- **In review:** onboarding checklist.
- **Next:** usability session on Friday.

No connected service, email send, posting or real organization data is required.
OpenWork canonicalizes a newly saved skill's name with a suffix and rewrites
frontmatter; use the exact returned catalog capability, not a guessed name.
The preflight compares the instruction body, not byte-for-byte generated
frontmatter.

A skill-retrieval round trip proves storage/discovery, not that a model produced
this brief, that outgoing actions are authorized, or that directory policies
allow dynamically fetched instructions.

## Native host matrix

Record date, client version/surface, submitted endpoint and build SHA; sanitize
identity, cookies, URLs, tokens, internal IDs and unrelated data in evidence.

| Host | Required positive | Required negative/recovery | Current result |
| --- | --- | --- | --- |
| ChatGPT desktop + mobile | User OAuth, selected workspace, exact individually exposed public tools; final result/recording | Denied action, invalid args, refresh, revoke, denied cross-workspace access | **Not tested; generic gateway policy mismatch first.** |
| Codex CLI / ChatGPT desktop | Install plugin/direct MCP, loopback OAuth, declared skill/tools | Same security boundaries; IDE uses direct MCP rather than unsupported plugin bundle | **Not tested.** |
| Claude web / desktop / supported mobile | Connector add, hosted OAuth, ≥3 repeatable outcomes | Invalid args, unavailable capability, refresh/revoke/isolation | **Not tested; architecture preflight first.** |
| Claude Cowork | Plugin+connector pairing, skills/commands actually supported there | Missing connection or grant does not become success | **Not tested.** |
| Claude Code | Native plugin install, loopback OAuth, text result | No UI-rendering claim; denied grant and revoked auth refused | **Not tested.** |
| Cursor desktop | Package load, OAuth and fixture result | Invalid/unsupported request, revoked grant, token refresh, wrong workspace | **Not tested.** |
| Cursor web / Cloud Agent | Separate hosted callback and usable declared tools | No assumed sharing of desktop auth; missing configuration explicit | **Not tested.** |

Tools, resources, prompts and grants may differ by account. Inventory the
**actual production submission endpoint**, not just the QA organization. Every
declared tool needs a meaningful success test and invalid-input handling.

## Private handoff template

Enter privately in the relevant provider form, after checking each item:

```text
Login URL: [actual login URL]
Username/password: [from secret manager]
Workspace to select: [isolated persistent workspace]
Available sample data: [exact assigned items]
Granted capabilities: [exact reviewed operation list]
Prerequisites: [already complete; no additional reviewer setup]
Positive prompts: [tested platform-specific cases]
Negative prompts: [tested refusal/clarification cases]
Reset/support contact: [monitored company inbox]
Access lifetime: [covers review; owner-maintained]
```

Do not attach the provisional bootstrap assertion, claim links or short-lived
token instead of a reviewer login. Portal access and directory approval remain
separate from a passing preflight.
