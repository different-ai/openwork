# Evidence-led SEO/GEO editorial and distribution plan

**Status: review-only dry run.** This document proposes work; it does not publish pages, submit listings, contact moderators, post comments, purchase placements, or authorize those actions. Keep this PR unmerged until the owner reviews the plan and approves. Approval to merge documentation is not approval to conduct outreach or publish comparison claims.

Research snapshot: 2026-10-10. Repository reference: `origin/dev` at `25b75edec`. Recheck sources and the shipping release before publication; repository code is not proof that a feature is available to every user.

## 1. Objective and guardrails

Help people make a defensible choice about an agent workspace, organization-managed access, and model infrastructure. Earn useful citations and qualified adoption through evidence, not comparison-page volume or repetitive link drops.

Keep three OpenWork surfaces distinct:

- Desktop: an open-source workspace for doing work on files with AI agents.
- MCP gateway: organization-assigned capabilities available through an MCP connection.
- Den: organization administration and provisioning.

A desktop capability is not automatically a gateway capability, and code in Den is not automatically an enabled enterprise policy. Cite the relevant shipping surface and edition.

Use the [PostHog AEO handbook](https://posthog.com/handbook/content/aeo-guide) for the separation of crawling, mentions, citations, visits, and conversions, and [PostHog's practical AEO advice](https://posthog.com/blog/aeo-advice) for owned-content-first prioritization and skepticism about prompt selection. Their reported growth is their experience, not an OpenWork forecast or causal guarantee.

Editorial rules:

- Lead with a direct answer, then a concrete workflow and evidence. Make each section understandable when quoted alone.
- State what the other product does well. Include a prominent **Choose the other product when…** section, not a footnote.
- Never invent testimonials, competitor limitations, adoption numbers, benchmark results, or current prices. Do not republish outside people's names or identifying examples into this public repository.
- Separate observed behavior, vendor-documented behavior, inference, and unverified claims. A blank comparison cell means “not verified,” not “unsupported.”
- No promises of full offline operation, zero data egress, guaranteed privacy, enforced allowlists, retention controls, certifications, or regulatory compliance without shipping evidence and appropriately scoped documentation. Files on a local disk do not imply model requests stay local.
- Clear headings, accessible HTML, canonical URLs, meaningful internal links, and accurate structured data are hygiene. Schema and `llms.txt` are not guarantees of indexing, citations, ranking, or model recommendations. Only describe content actually on the page; do not manufacture FAQ answers or review markup.

## 2. Research and publication gate

Before drafting publishable copy, assign an editorial owner, a product reviewer, and a technical verifier. Maintain a claim ledger per page:

| Field | Required evidence |
| --- | --- |
| Claim and decision it supports | Exact sentence, named product surface, edition, region if relevant |
| Source | Official URL, section, access date, and bounded supporting excerpt |
| Availability | Shipped release/version; preview, rollout, license, account and admin prerequisites |
| Verification | Reproduction steps, synthetic input, actual output, limitations, and date |
| Cost | Dated official pricing or explicitly “contact sales”; inference, seats, hosting and operating effort separately |
| Approval | Reviewer, accepted wording, refresh date, and correction owner |

Use official docs and release notes first; use independent reviews for clearly attributed perspectives, not as proof of a technical feature. Read linked security and licensing documents before making security or entitlement claims. Contradictions block the claim until resolved. Recheck immediately before publishing, monthly for pricing/availability, and quarterly for workflows; earlier if a relevant release changes behavior.

For demonstrations, use synthetic files and a clearly recorded version/configuration. Test success and failure cases, permissions, setup effort, and output quality. Do not create accounts, authorize browser login, run paid model tasks, or capture private workspace output without permission. Publish a neutral test protocol even when there is no winning product.

### Official starting sources

Fetched in this dry run (unless marked otherwise); these establish research starting points, not a completed product audit:

- [LiteLLM overview](https://docs.litellm.ai/docs/): documents its SDK, LLM proxy, routing, and links to MCP and agent gateway surfaces. Do not reduce LiteLLM to an old feature set.
- [Microsoft 365 Copilot overview](https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-overview): describes app integration, organizational grounding, licensing-dependent experiences, and links to protection/administration documentation. The fetched page was updated October 1, 2026; recheck edition names and tenant availability.
- [ChatGPT Enterprise](https://openai.com/chatgpt/enterprise/): redirected to the current ChatGPT enterprise site; describes enterprise work and agent experiences. Read the current destination before publication rather than treating ChatGPT as only a chat box.
- [OpenCode V2 plugin API](https://opencode.ai/v2/docs/build/plugins/) and [V2 documentation index](https://opencode.ai/v2/llms.txt): version-specific starting points. Use V2 documentation for commands and compatibility.
- OpenWork's [plugin README](../packages/opencode-plugin/README.md), [plugin guide](../packages/docs/model-context-protocol/opencode-plugin.mdx), and [`package.json`](../packages/opencode-plugin/package.json): command and package references, not evidence of all product surfaces.

Required follow-up sources, **not yet reviewed in this dry run**: [LiteLLM proxy](https://docs.litellm.ai/docs/simple_proxy), [LiteLLM enterprise](https://docs.litellm.ai/docs/enterprise), [Microsoft licensing](https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-licensing), [Microsoft data protection](https://learn.microsoft.com/en-us/microsoft-365/copilot/enterprise-data-protection), [OpenAI business data](https://openai.com/business-data/), and [ChatGPT pricing](https://chatgpt.com/pricing/). Follow current official links for retention, residency, admin controls, connectors, and prerequisites; do not infer those terms from marketing copy.

## 3. Prioritized comparison-page briefs

These are briefs, not public URLs or finished claims. Draft one substantive page at a time. Start with the LiteLLM relationship because a false replacement claim would mislead infrastructure buyers; then evaluate Microsoft 365 Copilot and ChatGPT Enterprise. Reorder only with documented demand evidence, not a flattering visibility score.

Every page needs an answer-first summary; “who this is for”; a workflow-level table with source-linked cells; setup and total-cost discussion; data-flow boundaries; a worked example; limitations; the other-product section; and a dated evidence/methodology note. Avoid three pages built by swapping competitor names in one template.

### P0: OpenWork with LiteLLM — workspace versus model infrastructure

**Reader/job:** a platform team already routing model calls, or a user who needs a usable workspace rather than another API.

**Working title:** “OpenWork and LiteLLM: different layers, when to use both.” Address “OpenWork vs LiteLLM” intent explicitly without calling OpenWork a drop-in replacement.

**Core answer to substantiate:** OpenWork's desktop workspace and LiteLLM's SDK/proxy solve different jobs. Infrastructure and workspace can be complementary. Den/gateway functions may overlap with some LiteLLM functions; compare those individually instead of claiming either tool has no gateway or agent support.

**Substantive outline and evidence tasks:**

1. Map user workspace, client configuration, model endpoint, credentials, tool gateway, and administration as distinct layers.
2. Compare SDK integration, request routing/fallback, budgeting/observability, interactive file work, MCP capabilities, and operational burden. Cite current docs for each; do not use an unchecked grid of green ticks.
3. Proposed joint workflow: a synthetic CSV/report task through OpenWork with an approved LiteLLM endpoint. Verify authentication, model discovery, streaming, tool calls, errors, and configuration on named releases before publishing a “works with” recipe. Compatibility is a test target, not a dry-run result.
4. Explain where credentials and logs live, who operates the proxy, and where content is sent. No blanket local-only promise.
5. Compare incremental cost of adding a workspace to an existing proxy against replacing infrastructure. Keep model charges and maintenance separate.

**Choose LiteLLM when…** the primary requirement is a provider-normalizing SDK, a model proxy for existing applications, or specific routing/observability controls confirmed in its current documentation. If the current UI already meets users' needs, an additional workspace may be unnecessary. Do not recommend migrating a functioning proxy merely to get a desktop UI.

**Choose OpenWork when…** the verified need is an interactive workspace for users' file tasks. “Use both” is a legitimate outcome only after the actual integration is tested. End with separate workspace-evaluation and infrastructure-reading links.

### P1: OpenWork versus Microsoft 365 Copilot — file workspace versus suite-native work

**Reader/job:** a team deciding whether work should happen in a dedicated agent workspace or within its existing Microsoft 365 environment.

**Working title:** “OpenWork vs Microsoft 365 Copilot for everyday team work.” Explicitly state **Microsoft 365 Copilot, not GitHub Copilot**. Distinguish Copilot Chat, licensed Microsoft 365 experiences, and Copilot Studio where relevant; do not borrow GitHub Copilot's features, pricing, or coding benchmarks.

**Substantive outline and evidence tasks:**

1. Contrast local-folder tasks with Word/Excel/Outlook/Teams workflows and organizational context. Do not imply a connection equals native in-app integration or identical permissions.
2. Run a synthetic document-summary and spreadsheet-to-report scenario in both environments. Record source handling, output review, app handoffs, setup, and required entitlements; no invented productivity percentages.
3. Compare model/provider choice, workspace extensibility, Microsoft app integration, organization administration, and actual data boundaries. Separate desktop behavior from Den controls.
4. Document license/tenant/region prerequisites and setup work. Recheck pricing and app availability; do not quote a remembered per-seat price.
5. Explain switching costs and coexistence. A team can keep suite-native work in Microsoft 365 and use a separate workspace for other tasks.

**Choose Microsoft 365 Copilot when…** most work and context already live in Microsoft 365, and verified suite-native experiences and tenant governance are the deciding requirements. OpenWork must not be described as an interchangeable implementation of Microsoft Graph grounding, Purview controls, or Microsoft contractual protections.

**Choose OpenWork when…** a tested task benefits from a dedicated file workspace and verified extensibility/provider options. Show the actual task and trade-offs rather than claiming universally better security or cheaper enterprise operation.

### P1: OpenWork versus ChatGPT Enterprise — extensible workspace versus managed enterprise offering

**Reader/job:** an organization weighing a configurable workspace and organization capability delivery against a centrally managed ChatGPT offering.

**Working title:** “OpenWork vs ChatGPT Enterprise: workflows, deployment, and operating responsibility.” Compare the Enterprise edition, not consumer ChatGPT or an API subscription. Include current agent/work experiences where the edition actually provides them.

**Substantive outline and evidence tasks:**

1. Identify the exact current Enterprise offering and eligible experiences. Separate vendor documentation, previews, and tested entitlements.
2. Evaluate a synthetic multi-file reporting task and an approved-tool task: input handling, supported actions, review/permissions, output delivery, and failure recovery.
3. Compare workflow customization, model/provider options, client choices, administration, connectors, and maintenance responsibility, each with scoped evidence.
4. Diagram model requests and connector/tool calls. Read actual data/retention terms before comparing them. Open-source software alone is not evidence of compliance or absence of external processing.
5. Document procurement and cost components. Use a dated quote only with publication permission; otherwise “contact sales.” Do not claim that an OpenWork deployment inherits OpenAI Enterprise protections.

**Choose ChatGPT Enterprise when…** a supported, managed OpenAI workspace and verified enterprise contractual/admin capabilities fit the organization's requirements and procurement process. A team that does not want to operate or configure additional infrastructure may reasonably prefer it.

**Choose OpenWork when…** the verified priority is a configurable agent workspace or delivering organization capabilities to existing clients. Acknowledge setup, model billing, maintenance, and any missing verified enterprise requirements. Existing ChatGPT adoption is not itself a reason to switch.

## 4. Distribution candidates, not completed submissions

Checks below establish reachable resources or explicitly record blocked checks. They do **not** establish acceptance, live contribution rules, category fit, permitted promotion, or ownership of an existing listing. No submissions or contacts occurred. Before each action, record the current rules URL, access date, eligibility, existing OpenWork entries, maintainer approval if needed, and the owner-approved draft. Prefer correcting a useful existing entry over making duplicates.

| Priority | Candidate and dry-run evidence | Fit and required check before action |
| --- | --- | --- |
| P0 | [Official OpenCode ecosystem](https://opencode.ai/docs/ecosystem/) — HTTP 200 | Potential plugin/project listing. This is a legacy-path directory, not V2 command documentation. `/v2/docs/ecosystem` and `/ecosystem` returned 404. Confirm current maintainer submission route and V2 eligibility; never invent a V2 listing route. |
| P0 | [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode) — HTTP 200 | Real OpenCode-specific resource. Read current contribution guidance and existing entries; describe `opencode-openwork` specifically where appropriate. |
| P1 | [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) and [wong2/awesome-mcp-servers](https://github.com/wong2/awesome-mcp-servers) — HTTP 200 | Candidate for the actual MCP gateway, not a desktop app mislabelled as a server. Check hosted/authenticated-server eligibility, categories and duplication. |
| P1 | [Official MCP Registry](https://registry.modelcontextprotocol.io/) and [registry documentation](https://modelcontextprotocol.io/registry/about) — HTTP 200 | Verify publisher identity, naming, remote-server metadata, authorization, and registration requirements. A registry entry is not a security endorsement. |
| P1 | [Smithery](https://smithery.ai/) and [Glama MCP directory](https://glama.ai/mcp/servers) — HTTP 200 | Assess authenticated remote-server support and verification/access requirements. Do not provide private credentials to a crawler or imply public unauthenticated capabilities. |
| P2 | [AlternativeTo](https://alternativeto.net/) — HTTP 403; inspection blocked | Known alternative-site candidate only; current listing/rules unverified. Manually check access, duplicate entries, taxonomy, disclosure and edits. Do not classify OpenWork as a complete LiteLLM replacement. |
| P2 | [Product Hunt](https://www.producthunt.com/) — HTTP 200 | Consider only for a substantive launch with support capacity. Read current launch rules; no vote solicitation, fabricated reviews or relaunch spam. |
| P0 maintenance | [npm package metadata](https://registry.npmjs.org/opencode-openwork) — HTTP 200; latest `0.1.0` | Existing package metadata matched the repository version at check time. Audit README, provenance, install path and ownership; not a new package submission. No `npm` CLI needed or used. |
| P1 maintenance | [Homebrew OpenWork cask](https://formulae.brew.sh/cask/openwork) — HTTP 200 | Existing desktop distribution surface. Check official release/version and metadata; don't submit a duplicate cask or treat reachability as installer validation. |
| P2 feasibility | [WinGet manifests](https://github.com/microsoft/winget-pkgs) — HTTP 200; [Flathub](https://flathub.org/) — HTTP 200 | Package-manager candidates, not verified OpenWork listings. Search existing entries; evaluate signed releases, update ownership, packaging/sandbox requirements, support and review rules before proposing submission. |

Initial execution limit after separate approval: one relevant OpenCode entry/update and one eligible MCP entry/update, with a human reading each diff. Defer alternative-site launches and new packaging until product facts and maintenance ownership are settled. Do not buy links or request mass listings.

## 5. Community participation candidates and disclosed drafts

Candidate communities: [r/opencode](https://www.reddit.com/r/opencode/), [r/selfhosted](https://www.reddit.com/r/selfhosted/), [r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/), and [r/mcp](https://www.reddit.com/r/mcp/). Their `about.json` checks returned HTTP 403 in this dry run: existence/activity, live rules, and posting permission are **not verified here**. If a candidate is inactive or a poor fit, drop it.

Before replying or posting, manually inspect the community, pinned threads, current promotion/link rules, account requirements, and relevant existing discussion. Obtain moderator permission when rules require it or the fit is unclear. Log approval privately without exporting outside people's identities to this public repo. If access or permission remains unresolved, do not post.

- Disclose affiliation in the first sentence. Never impersonate a neutral reviewer or customer.
- Prefer a useful answer to an existing specific question; solve the problem in the reply even if no link is permitted. Link only when necessary and allowed.
- No repeated cross-posts, unsolicited DMs, vote coordination, astroturfing, automated promotion, fabricated testimonials, or fake “I switched and saved…” stories.
- For self-hosting/local-model discussions, state the tested deployment and external services involved; don't conflate this cloud plugin example with an offline workflow.
- Track useful conversation and qualified follow-up, not link count. Respect removals; don't evade them using another account or repost.

### Draft reply: an OpenCode user asks how to load organization models and tools

**Draft only; no account has posted this.** A real affiliated person must review and adapt the disclosure; do not publish a fictional identity or unsupported firsthand test result.

> Disclosure: I'm affiliated with OpenWork. If your question is specifically about bringing an OpenWork organization's models and MCP connections into OpenCode, the `opencode-openwork` plugin is one option; you don't need the desktop app for that path. This requires an OpenWork organization and compatible OpenCode V2; our README names 2.0.26 as the tested version.
>
> Check your installed executable first. Installing the plugin does not upgrade OpenCode:
>
> ```sh
> opencode --version
> opencode plugin add opencode-openwork
> ```
>
> Then **you**, not an installation agent, approve browser sign-in:
>
> ```sh
> opencode auth login openwork --method browser --standalone
> ```
>
> After approval, inspect what your organization actually makes available:
>
> ```sh
> opencode auth list
> opencode models | grep ipr_
> opencode mcp list
> ```
>
> Use `opencode2` instead of `opencode` throughout if that's your V2 executable. Model/connection lists can initialize asynchronously; an initially empty list isn't proof of failed login. If your organization hasn't granted models or connections, installation won't create that access. Ask before restarting a background service because it may interrupt work.
>
> To sign out:
>
> ```sh
> opencode auth logout openwork
> ```
>
> If you only need your existing provider or a single MCP server, configuring that directly may be enough; adding this plugin isn't necessary. The [README](https://github.com/different-ai/openwork/tree/dev/packages/opencode-plugin) has requirements and troubleshooting. This is a cloud-organization integration, not a promise that model or tool traffic stays on your machine.

These are actual documented plugin commands, cross-checked against repository README and guide; the registry reported version `0.1.0`. **They were not executed in this dry run**, and no login was authorized. Before outreach, reproduce them on the published package and compatible V2 executable, with an approved synthetic test organization; record successful and failing checks without exposing credentials. Recheck the linked README against the installed version rather than assuming `dev` matches a release.

### Draft permission-gated post

**Working title:** “An OpenCode V2 plugin for loading your OpenWork organization's models and MCP connections.”

Use the disclosed reply above as the practical body, plus a short prerequisites section and documented limitations. Ask “Which setup step is unclear?” rather than fishing for endorsements. Only post if moderators permit this kind of affiliated tutorial; otherwise keep it as owned documentation. Do not add privacy/policy guarantees, untested remote-session features, or testimonial-style language.

## 6. Measurement: separate stages, separate claims

Establish a baseline before approved publication. Report weekly diagnostics and a monthly decision memo; do not promise a citation or conversion lift by a deadline.

| Stage | Measurement | Limitations |
| --- | --- | --- |
| Crawling | Approved server/CDN logs: bot/agent fetches by canonical page, response status, blocking, date; search indexing checked separately | Verify bot identity where possible. A fetch is not indexing, training, retention, or citation. |
| Mentions | Fraction of sampled nonbranded answers naming OpenWork; record accurate versus inaccurate descriptions separately | Only describes the sampled panel; repeated outputs are noisy and not market share. |
| Citations | Fraction linking to an OpenWork canonical URL; also record cited page and useful source context | A mention without a link is not a citation. Third-party links and owned-site citations are distinct. |
| Visits | Known assistant referrals, permitted campaign links for outreach, relevant landing-page visits and download-link clicks | Missing referrers and later branded searches prevent complete attribution; unknown/direct traffic isn't automatically AI traffic. |
| Conversions | Define separately: desktop download click, observed activation where already available and appropriately collected, cloud signup, qualified evaluation | Download clicks aren't installs; signups aren't successful tasks. Deduplicate observed attribution and voluntary self-report; show unknowns. |

Only use existing, consent-appropriate analytics in this phase. Instrumentation changes or an attribution survey need a separate reviewed implementation and data-minimization decision. Do not collect raw user prompts or file contents by default. If voluntarily gathering discovery prompts, redact and aggregate them before sharing; never put identifiable customer narratives in a public fixture.

### Realistic prompt panel

Start with 12–20 nonbranded prompts, versioned by job and intent. The following are **candidate prompts**, not validated search demand. Before adopting them, attach a demand signal from aggregate search queries, consented/redacted discovery feedback, or actual public questions. Don't tailor them with a checklist of features only OpenWork has.

- “What tools can help me turn a folder of CSVs and PDFs into a weekly report?”
- “How should a small operations team evaluate AI workspaces for shared workflows?”
- “What are alternatives to Microsoft 365 Copilot for document and spreadsheet work?”
- “Should our team use ChatGPT Enterprise or a separate agent workspace?”
- “We already have a model gateway. Do we need a separate workspace for end users?”
- “How can we give an existing coding agent access to approved team tools?”
- “What is the simplest way to manage AI assistance for a team already working in Microsoft 365?”
- “When is a hosted AI workspace preferable to running an open-source agent app?”

Include vulnerability prompts that can reasonably favor another product; do not remove them when results are unfavorable. Keep LiteLLM infrastructure intent as a separate topic cohort rather than pooling it with workspace intent.

Run a fixed panel across a small named set of available assistants, in fresh sessions, three repeated runs per prompt per review cycle. Record date, exact prompt, model/version if exposed, browsing mode, locale, answer, citation URLs, and judging rubric. Separate browsing and non-browsing results. Run only after approval and within a stated budget; do not simulate answers or claim this dry run collected a baseline.

Track branded accuracy separately: “What is OpenWork?”, “How do I use OpenWork in OpenCode?”, “Does OpenWork replace LiteLLM?”, and “Does using OpenWork mean no data leaves my machine?” Grade surface distinctions, factual correctness, version accuracy and unsafe overclaims. **Exclude all branded prompts from nonbranded visibility/citation denominators.**

Compare a panel to itself over time, keeping prompt revisions as explicit new cohorts. Show counts and denominators rather than one dramatic percentage; note provider/version changes and small-sample uncertainty. Third-party visibility numbers with different panels are not comparable. Publication timing and changed mentions are correlation, not proof that a page caused adoption.

## 7. Dry-run outcomes and approval sequence

### Completed in this documentation-only preparation

- Read both requested PostHog sources and the official vendor overview pages; assembled bounded research briefs rather than publishing a current-feature comparison matrix.
- Identified reachable directory/package candidates and recorded failed checks instead of treating them as eligibility approval.
- Located an existing Homebrew cask and npm package metadata; no installation or package submission performed.
- Cross-checked plugin command drafts against repository documentation; no login, model task, or shell installation performed.
- Recorded blocked Reddit checks and the nonexistent V2 ecosystem URL as explicit follow-up items.
- No public outreach, moderator contact, comparison publication, paid placement, prompt-panel run, crawl audit, or conversion baseline was performed. There are no measured growth results to report.

### Proposed sequence after review

1. **Approve scope, not claims:** select the first brief, research owners, evaluation budget, panel candidates and correction owner. Review this docs PR without merging automatically.
2. **Research/reproduce:** complete the claim ledger and integration checks. Produce a publication preview and redact evidence. Stop if a central claim fails.
3. **Review publication dry run:** inspect exact copy, source ledger, rendered page, links/canonical/schema, release availability, other-product section, and proposed destinations. Any site code/UI work goes through its own feature/design/review process.
4. **Explicit publication approval:** publish only the approved artifact. Maintain a correction log and remove unsupported claims promptly.
5. **Separate outreach approval:** review current rules/mod permission, exact disclosed copy, destination and account ownership. Submit at most the agreed small batch; report accepted, pending, rejected and blocked honestly.
6. **Observe and reassess:** compare stage-specific measurements against baseline over subsequent weeks. No effect is an acceptable result; improve useful content instead of increasing spam volume.

### Owner review checklist

- [ ] Is this still a docs-only PR, unmerged pending review, with no publication or outreach authorization implied?
- [ ] Are desktop, MCP gateway and Den capabilities distinguished and tied to shipping evidence?
- [ ] Does LiteLLM appear as potentially complementary infrastructure, with any “works with” recipe still gated on testing?
- [ ] Is the Microsoft page specifically about Microsoft 365 Copilot, with no GitHub Copilot conflation?
- [ ] Does ChatGPT Enterprise research cover current eligible experiences rather than an outdated chat-only stereotype?
- [ ] Does every page have a useful, prominent “choose the other product” section and a concrete test plan?
- [ ] Are prices, policies, availability, security and compliance claims sourced, scoped and refreshed before publication?
- [ ] Are directory checks labelled as candidate checks, with existing entries/blocked access and live rules still to review?
- [ ] Will Reddit participation require live rules and any needed moderator permission, affiliation disclosure and a genuinely useful answer?
- [ ] Are plugin commands matched to the published version and tested before posting, with human-only login and no invented testimonial?
- [ ] Are crawling, indexing, mentions, citations, visits and conversion definitions separated, with branded accuracy excluded from visibility?
- [ ] Are prompt demand, sampling limitations, unknown attribution and absence of dry-run growth results explicit?
- [ ] Are all evidence and drafts free of secrets, identifying outside-person/customer details and unshipped guarantees?
- [ ] Are publication and outreach separate affirmative approvals with named maintenance/correction responsibility?
