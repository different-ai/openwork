# Unsent architectural preflight drafts

These are drafts, not sent messages or eligibility decisions. An authorized
owner should choose the contact identity, approve the content and use their
provider account/support channel. Do not include tokens, reviewer passwords,
customer names, actual organization IDs or sample production records.

## OpenAI: generic gateway versus curated public surface

**To:** the authorized publisher's OpenAI plugin-review/support channel. No
current public review email was established; do not invent one.

**Subject:** OpenWork MCP gateway — public Plugin Directory architecture preflight

We are preparing OpenWork for the universal Plugin Directory shared by ChatGPT
and Codex. OpenWork has its own organization-scoped Library and reusable work,
plus organization-authorized connections. Our existing OAuth gateway is
https://api.openworklabs.com/mcp/agent.

The current gateway exposes search_capabilities, execute_capability and a script
executor. The operations can vary by member grants and organization connections.
We understand your current tool-independence rule prohibits discovery plus a
generic executor for operations not individually exposed for review, and that
plugins primarily functioning as unofficial third-party pass-through connectors
are not eligible. We are not asking to conceal that behavior or obtain approval
based only on a restricted demo account.

Would a separate, enforceably bounded OpenWork-native Library surface—each
list/read/add operation individually exposed with fixed schemas, no arbitrary
execution or downstream connectors, and versioned bundled workflows—be an
appropriate submission direction? Is there a preferred preflight process for
confirming that scope before implementing and fixing its public MCP URL?

Please also clarify general-audience/under-18 eligibility for a product whose
current account terms require users to be 18+, and any specific disclosures
needed for persisted Library items and private-workspace operations.

We will provide a fully configured durable reviewer account and tested cases
through secure portal fields after the architecture and eligibility gaps are
resolved.

## Anthropic: connector and linked plugin scope

**To:** `mcp-review@anthropic.com`

**Subject:** OpenWork connector — mixed-operation and dynamic-skill preflight

We are preparing an OpenWork MCP connector and linked plugin bundle for the
Claude directory. Our current OAuth gateway is
https://api.openworklabs.com/mcp/agent. It exposes member-authorized Library
skills, workflows and configured connections through search_capabilities and
execute_capability, plus a script executor and direct skill tools.

The generic executor can dispatch both reads and mutations; its annotations are
conservatively non-read-only/destructive. We understand that the review criteria
reject mixed safe/unsafe catch-all tools and that tool descriptions must not
instruct Claude to fetch external behavioral instructions dynamically. Our
current flow retrieves and follows authorized SKILL.md content, so we would like
to resolve this before making compliance acknowledgments.

Could you confirm whether this architecture is eligible, or whether we should
submit a separate bounded surface with independently typed read/write tools,
fixed reviewed workflows and no arbitrary downstream execution? How should
member-requested retrieval of their own saved Library text be distinguished
from remotely fetched behavioral instructions?

For downstream services, what proof of proxy permission and restrictions on
user-added MCPs is required? We will not treat user authentication alone or a
benign reviewer workspace as proof that all possible operations comply.

We plan a dedicated persistent account populated with synthetic data and no
production credentials, at least three repeatable tested outcomes, and separate
Claude web/Cowork/Code OAuth validation. Please let us know the appropriate next
preflight step.

## Cursor: publisher scope and paid-backend boundary

**To:** `marketplace-publishing@cursor.com`

**Subject:** OpenWork Connect — publisher application and backend entitlements

We are preparing a small MIT-licensed, open-source OpenWork Connect plugin with
one remote OAuth MCP connection and a reusable skill. It includes no binaries,
launchers, hooks or embedded credentials. The gateway provides the tools and
reusable work assigned to the signed-in member's OpenWork workspace.

We intend to apply through https://cursor.com/marketplace/publish and understand
this is distinct from cursor.directory. Is a small standalone public repository
exported from our monorepo the preferred review source?

The plugin itself has no install charge or added fee. Some users may already
have paid OpenWork accounts or backend entitlements. Please clarify how the
Publisher Terms' direct/indirect charging restriction applies to access to an
existing paid backend, and which disclosures should appear in the application.
We do not want to infer an exemption from other marketplace listings.

Do you need a preconfigured reviewer account or a particular OAuth test surface
(desktop, web/Agents or both) with the publisher application? We are preparing
an isolated synthetic-data workspace and native-client tests separately from
the public application.
