# ENG-76: Slack Web API feasibility and distribution gates

Status: **Research for the design interview, not an implementation plan or legal clearance**

Retrieved: **2026-09-28**
Evidence: current, public, first-party Slack terms, developer documentation, and Help Center pages. No live workspace, credentials, app settings, or private agreement was inspected.

## Scope and conclusion

**Product-scope update, 2026-09-30:** the user subsequently requested hosted Cloud support across workspaces without per-workspace configuration, built and demonstrated before Slack approval. Marketplace/RTS approval is part of the launch path. The interview inputs below describe the earlier scope; current implementation scope is [ENG-76](../eng-76-native-slack-connect.md) and [ADR 0002](../adr/0002-cloud-slack-before-distribution-approval.md). Provider eligibility findings remain relevant to release, not a blocker to synthetic implementation/demo work.

Interview inputs, not provider findings: OpenWork supplies the Slack app; members need no developer setup, although workspace approval and member consent are acceptable. The initial workflow is **find discussions → read threads → answer in OpenWork with source links**, without sending messages. A working integration is the completion target; Slack Marketplace submission is excluded. Official Slack MCP is excluded as a product decision.

**The HTTP methods and member OAuth flow exist, but an unlisted, externally supplied, commercially connected OpenWork integration is not established as an authorized delivery path.** Direct Web API calls do not remove Slack's commercial-distribution terms. The preferred search API also expressly excludes unlisted distributed apps, while the legacy search route has material usage restrictions. These are decision gates, not merely implementation details or rate-limit tuning. [S1], [S3], [S5], [S6], [S7], [S8]

| Dimension | Finding | Consequence for ENG-76 |
| --- | --- | --- |
| Technical capability | User-token search, conversation/thread reads, message permalinks, and server-side OAuth are documented. [S5], [S7], [S9], [S10], [S12], [S17] | The read-only workflow has technical building blocks; this is not evidence that a particular new app can use them under its intended distribution model. |
| Commercial authorization | Commercial distribution requires a separate authorizing agreement; the definition includes a free app connected to a paid product/service. [S1] | “No Marketplace submission” and external commercial use cannot be treated as an already-cleared combination. No other authorizing agreement was established by this research. |
| Modern search eligibility | Real-time Search (RTS) is available to directory-published and internal apps only, not unlisted distributed apps. [S7] | Calling `assistant.search.context` directly rather than through Slack MCP does not avoid this gate. |
| Legacy search | `search.messages` / `search:read` remain documented but are legacy; RTS guidance says not to use them; Marketplace guidance lists `search:read` among unsuitable legacy/restricted scopes. [S5], [S6], [S7], [S8] | Do not designate legacy search as a provider-approved fallback for a new unlisted commercial AI connector. Exact eligibility outside those documented contexts remains unresolved. |
| Performance | New unlisted commercial installations face 1 request/minute and 15 objects/request on **each** of history and replies. [S9], [S10], [S11] | Reading several threads or a long thread can require minute-scale waits; working search does not imply interactive full-thread reading at useful volume. |
| Privacy | User tokens reflect the member's access, not every private channel/DM in the organization. RTS private/DM scopes also require consent and can be revoked. [S7], [S13], [S21] | Workspace installation is not permission to reuse one person's visibility for everyone. |

## 1. Applicable terms and what “commercial” / “internal” mean

### Current text and document precedence

The current canonical **Slack API Terms of Service** page states **Effective: October 10, 2025**. It defines “APIs” broadly to include APIs, SDKs, sample code, developer tools, and related documentation/materials. The API Terms plus the Slack Application Developer Policy form the contract. Access must comply with that contract and Slack documentation. This is not an MCP-specific contract. [S1, introductory paragraphs; Relationships & Definitions; API Access]

The **Entire Agreement** section gives the order for conflicts with referenced documents: **(A) API Terms, (B) Slack Application Developer Policy, (C) other referenced documents/pages**. Accordingly, softer distribution-guide wording such as “recommended” cannot establish an exception to the express commercial-distribution restriction in the API Terms. A separately negotiated agreement is an expressly mentioned possible source of authorization, but none was reviewed. [S1, Commercial Distribution; Entire Agreement], [S3]

The Developer Policy, currently labeled **Effective Date: December 10, 2024**, defines an “Application” as any software application, functionality, website, product, or service created using Slack APIs. It also prohibits circumventing pricing, features, access structures, and access controls. Merely changing protocol or packaging is not evidence of different contractual treatment. [S2, introduction; Security; Business]

### Commercial Distribution: decisive wording

The API Terms say:

> “You may not Commercially Distribute an Application that integrates with the Slack APIs unless you are authorized to do so under a separate agreement with Slack or our parent company, Salesforce.” [S1, Commercial Distribution]

“Commercially Distribute” includes **any situation where the app integrates with Slack APIs and users could pay fees for the developer's product, service, or features**: direct payment, freemium, or a free app connecting to a paid product/service. The clause covers off-the-shelf apps, custom apps, and app templates connected to other products, services, or features. The text identifies Marketplace submission plus its agreement as the usual authorization route, or an authorizing Slack/Salesforce partner agreement. Read-only use and a free connector are not stated exemptions. [S1, Commercial Distribution]

The exception is narrower than “one installation”:

> “These restrictions do not apply if your Application and any products or services connected to it were created for use only by a single third party.” [S1, Commercial Distribution]

**Interpretation, not legal advice:** the exception tests both the app **and connected products/services**, not simply the number of workspaces in an initial trial. The source does not establish that a generally available OpenWork product qualifies because one organization tries its connector first. Whether the intended OpenWork offering is commercially distributed, or covered by an existing agreement or this exception, remains unverified. The exception also does not itself establish that Slack classifies the app as “internal” for RTS eligibility. [S1], [S7]

### Distribution mechanics are not distribution authorization

Slack documents three technical states: an **undistributed app** resides in its associated workspace; an **unlisted distributed app** uses OAuth and enabled distribution to install elsewhere; a **listed distributed app** has passed Marketplace review. The guide describes unlisted distribution as useful for early pilots but also says commercially distributed apps should be submitted and approved. Workspace policy may require administrator approval or permit only Marketplace-listed apps. [S3]

Slack's Enterprise administration guide separately describes the app's **Source** as **Internal** “if built by someone in your organization,” versus **Distributed** if a developer has not submitted it for Marketplace review. Rate-limit documentation uses the narrower phrase “internal customer-built applications.” These are not synonyms for “unlisted,” “private link,” or “installed in only one external workspace.” The API Terms do not supply a comprehensive standalone definition of “internal app”; classification of an OpenWork-supplied app is not established by these descriptions alone. [S4, View apps in your org], [S9], [S10], [S1]

**Gate:** a development completion criterion excluding Marketplace work does not settle authorization for external commercial use. The current evidence does not clear the combination of an OpenWork-supplied, potentially commercially connected app, external installations, no Marketplace approval, and no separately established authorization. This note neither chooses a different audience nor proposes a distribution workaround. [S1], [S3], [S7]

## 2. Search: technical support versus eligibility

### Legacy `search.messages` + user `search:read`

- The method takes a **user token** with `search:read`; its reference lists **Tier 2, 20+ requests/minute**. Results include text, channel ID, timestamp, author ID, and a `permalink`. It supports channel/DM and sender query filters and pagination with at most 100 results per page. Slack UI search filters can affect results; nearby matching messages can collapse to one match. Search output is therefore not a complete thread transcript. [S5]
- Both the method and scope are explicitly labeled **legacy** and recommend RTS. The broad `search:read` scope also permits `search.all` and `search.files`; choosing to expose only message search does not narrow the token to a public-channel-only search permission. [S5], [S6]
- The Marketplace suitability list rejects apps using legacy/restricted scopes such as `search:read`. This is Marketplace review guidance, not proof that every internal invocation of `search.messages` is universally forbidden. [S8, Apps unsuitable for Slack Marketplace]
- RTS **General usage guidelines** explicitly say: “DON'T use the legacy `search:read` scope and related `search.messages` and `search.all` endpoints in API requests.” Conversely, the method reference and OAuth guide still document that scope. These pages do not provide a clear, comprehensive eligibility matrix for new internal versus unlisted AI apps using only legacy search. **Unresolved:** its exact permitted use for the proposed new OpenWork app. Do not infer permission from the method's continued existence, nor overstate this as a verified universal ban on all legacy search. [S7, General usage guidelines], [S5], [S12]
- Independently of endpoint eligibility, the API Terms' commercial-distribution restriction still applies. A successful hypothetical API response would not establish commercial authorization. [S1]

### `assistant.search.context` / Real-time Search

- RTS is a **direct Web API**, not dependent on using Slack's MCP server. The Data Access API evolved into RTS; the current guide supports user-initiated queries from third-party systems with an active Slack connection. It returns only content the authenticated user can access. **Only directory-published and internal apps are eligible; unlisted distributed apps are explicitly excluded.** [S7], [S22]
- An outside-Slack call requires a **user token** obtained through each user's OAuth authorization. Bot-token calls require a Slack interaction `action_token`; user-token calls do not. A workspace bot token is not the documented substitute for member-visible external search. [S7], [S18]
- Required base scope: `search:read.public`. Optional content-category scopes: `search:read.private`, `search:read.im`, `search:read.mpim`; file search additionally needs `search:read.files`, and user discovery has `search:read.users`. Public search includes public channels in workspaces shared by the installed app and user, even if the user has not joined each public channel. [S7], [S23]
- Private-channel and DM/MPDM scopes are **user-token only**. The guide requires administrator and member permission for private content; the individual scope references say the user must consent within Slack and may revoke consent. “All private messages” in a scope table does **not** mean all members' private data: the guide expressly limits results to the searching user's access. [S7, User authentication; Required Scopes; Data privacy], [S21]
- The method returns source `permalink`s, optional surrounding `context_messages`, and at most **20 results/page**. Context around a thread message is limited to that thread, but is not promised to include the whole thread. Slack documents supplementing search with `conversations.replies` or `conversations.history`. [S18], [S7, Context call pattern]
- The guide calls for an **in-Slack experience** and says apps using user `*:history` scopes for RTS should not subscribe to user-level message events. Marketplace suitability guidance separately excludes apps with no Slack functionality and apps providing only an MCP server without meaningful in-Slack functionality. These are additional product-fit constraints, not permission to expand ENG-76's agreed read-only scope automatically. [S7, General usage guidelines], [S8]

### Correction regarding official Slack MCP

Official Slack MCP is not categorically “against Slack's ToS”: Slack publishes and documents it. Its current eligibility is **Marketplace-published or internal apps only**, and **unlisted apps are prohibited**. It requires a registered app/fixed identity and documents OAuth. This is a specific eligibility restriction, not a blanket prohibition on MCP as a protocol. ENG-76 can retain “do not use official Slack MCP” strictly as a product decision; direct RTS has the same listed/internal restriction. [S20], [S7]

## 3. Minimum read-only access and member boundaries

The following is a **technical scope map**, not an approved scope request or confirmation that a new app qualifies. History scopes are conditional on the conversation types the product actually includes. Search and read permissions are separate. [S5], [S7], [S9], [S10], [S24]

| Operation | Legacy search path | RTS path, if eligible |
| --- | --- | --- |
| Find messages in public channels | User `search:read` (broad legacy scope) | User `search:read.public` |
| Include the member's private channels | Covered by broad legacy search, within the user's visibility | Add user `search:read.private` and its consent |
| Include the member's one-to-one DMs | Covered by broad legacy search, within the user's visibility | Add user `search:read.im` and its consent |
| Include the member's group DMs | Covered by broad legacy search, within the user's visibility | Add user `search:read.mpim` and its consent |
| Read public-channel messages/threads | User `channels:history` | Same |
| Read private-channel messages/threads | User `groups:history` | Same |
| Read one-to-one DM messages/threads | User `im:history` | Same |
| Read group-DM messages/threads | User `mpim:history` | Same |
| Link to an already returned search hit | Use its returned `permalink`; no additional scope | Same |
| Resolve another message's source link | `chat.getPermalink`: authenticated token, **no additional scopes required** | Same |
| Determine connected Slack member/workspace | OAuth response IDs; optionally `auth.test`, **no additional scopes required** | Same |

Sources for scope table: legacy search [S5], [S6]; RTS categories and consent [S7], [S21], [S23]; reads [S9], [S10], [S24]; links [S17], [S18]; identity [S12], [S14], [S16].

Consequently, public-channel search plus thread reading has a two-scope technical base (`search:read` + `channels:history`, or eligible RTS `search:read.public` + `channels:history`). Adding private channels and both DM types means five legacy-path user scopes, or eight RTS-path user scopes. The legacy base still grants broad search access; an app-side channel filter is not a reduced OAuth grant. **These are derived scope counts, not authorization recommendations.** [S5], [S6], [S7], [S24]

`conversations.history` explicitly distinguishes token visibility: user tokens can access private conversations the user belongs to and all public conversations; bot tokens are limited to conversations the bot belongs to. The general token guide says user tokens represent the same workspace access the user has. Generic scope descriptions saying “the app has been added to” should not be mistaken for organization-wide private access or for an extra bot-invitation requirement on every user-token read. [S9, Usage info], [S13], [S24]

Channel metadata lookups are separate: `conversations.info` uses the matching `channels:read`, `groups:read`, `im:read`, or `mpim:read` scope. Name/profile enrichment with `users.info` needs `users:read`; accessing its email field additionally needs `users:read.email`. These are not inherent requirements for search-result IDs, thread text, authentication identity, or permalinks. No `chat:write` permission is required by the read-only operations above. [S25], [S26], [S5], [S9], [S10], [S16], [S17]

**Boundary implication:** each OpenWork member must use their own authorized Slack identity for member-visible results. Slack security guidance requires tokens linked to their workspace/user owner and prohibits exposing one user's token functionality to another. Admin approval is distinct from each member granting private/DM search access. [S15, Safe token storage; Session layer], [S7, Data privacy]

## 4. OAuth and an OpenWork-owned confidential client

For the standard flow, the browser authorization endpoint is `https://slack.com/oauth/v2/authorize`. **User scopes belong in `user_scope`; bot scopes belong in `scope`.** User-only requests are documented. The registered HTTPS callback receives the temporary code; the server exchanges it at `https://slack.com/api/oauth.v2.access` with the app's client ID and secret. Slack recommends HTTP Basic authentication for those client credentials, consistent redirect URIs, and checking returned `state` against the value sent. [S12], [S14]

With `oauth.v2.access`, user access details are under **`authed_user.access_token`, `authed_user.scope`, `authed_user.token_type`, and `authed_user.id`**. A top-level access token can be a **bot token**, so a generic “take `access_token`” integration would not reliably select the member token. Workspace and enterprise identity are also returned; `is_enterprise_install` distinguishes organization-level installs. `auth.test` can confirm token identity (`team_id`, `user_id`, and enterprise information when applicable) without an identity/profile scope. [S12], [S14], [S16]

Slack also documents a distinct user-only flow: **`/oauth/v2_user/authorize` uses `scope`**, paired with **`oauth.v2.user.access`**, whose example returns the user `access_token` at the top level. This is not the same response contract as standard `oauth.v2.access`; choosing one is an implementation decision not made here. Sign in with Slack identity scopes must not be mixed with ordinary API scopes in the standard OAuth request. [S12, User-centric flow; Requesting scopes], [S27]

**Server-side-only secret is supported and required for secrecy in the confidential-client design.** Slack expressly says not to distribute client secrets in native apps, client-side JavaScript, email, or public repositories. Its OAuth guide explicitly puts code exchange on the server. Therefore OpenWork can own the app/secret and serve the OAuth callback/token exchange without members creating Slack developer apps or receiving the secret. That is a technical fit for the interview requirement, contingent on app/distribution eligibility and workspace policy—not proof of approval. [S15, Securely manage credentials and secrets], [S12], [S3]

Current factual correction: Slack **does support public-client PKCE**. Its guide documents secretless exchange, native redirect restrictions, and rotation behavior. Thus “Slack always requires shipping a confidential secret to desktop users” and “Slack has no PKCE” would both be incorrect. This is not a proposal to change the selected server-managed product direction. [S28]

The OAuth response's **actually granted scopes** matter, particularly with optional scopes and administrator pre-approval. Slack says scopes accumulate across authorizations and cannot simply be removed from an existing token without revocation. Token rotation, where enabled, produces expiring access tokens and refresh tokens. Initial authorization-code grants are nested under `authed_user`, but a user-token **refresh** returns `access_token`, `refresh_token`, `expires_in`, and `token_type: "user"` at the top level; parsing must follow the requested grant type, not opportunistically select a token. An omitted refresh scope retains previously confirmed scopes only. See the [rotation guide](https://docs.slack.dev/authentication/using-token-rotation/#refresh), the [official user-token rotator](https://github.com/slackapi/python-slack-sdk/blob/main/slack_sdk/oauth/token_rotation/rotator.py), and [RFC 6749 §6](https://www.rfc-editor.org/rfc/rfc6749#section-6). A new read-only interface alone does not prove an existing grant contains no write scopes. [S12, Optional scopes; Appending scopes], [S14, Response]

## 5. Rate limits and Slack plan availability

### Rate limits

| API/use | Current documented limit | Qualification |
| --- | --- | --- |
| `search.messages` | Tier 2: **20+ requests/minute**, up to 100 results/page. [S5] | Legacy/eligibility concerns remain separate. |
| New unlisted commercial `conversations.history` | **1 request/minute; default and maximum 15 objects/request**. [S9], [S11] | Applies from May 29, 2025 to new apps/installations described by the policy. |
| New unlisted commercial `conversations.replies` | **1 request/minute; default and maximum 15 objects/request**. [S10], [S11] | Same class; a separate method quota, not 1/minute shared with history. |
| Marketplace / internal customer-built history and replies | Baseline **Tier 3: 50+ requests/minute**. [S9], [S10], [S11] | Do not ignore the distinct RTS supplement limit below. |
| `assistant.search.context` | Most teams **10+ requests/minute**, larger teams up to **400+**; additional **10 requests/minute per user**, with burst and daily constraints. [S18, Rate limiting] | Slack advises fewer than 10 calls per user inquiry; pagination counts. |
| History/replies supplementing RTS with the user token | **5 requests/minute, 100 messages/request**. [S18, Rate limiting] | Specific RTS call-pattern limit; not a blanket entitlement for unlisted commercial apps. |
| `chat.getPermalink` / `auth.test` | “Hundreds of requests per minute.” [S17], [S16] | Still obey rate-limit responses. |

General Web API limits are per **method, workspace/team, and app**, not multiplied by obtaining more member tokens. Slack returns HTTP 429 with `Retry-After`; its general guide says all Slack plans receive the same method rate-limit tier. **Paying for a Slack plan does not turn a newly unlisted commercial app into a Marketplace/internal app.** The latter is an inference from the independently documented plan and app-class rules. [S11], [S9], [S10]

Current method pages and the updated rate-limit guide expressly say **existing installations outside the Marketplace are not subject to the new posted limits**. The current changelog also includes new installations of existing unlisted apps. This does not help a newly created ENG-76 integration, and a documented rate limit is not an exception to commercial-distribution terms. [S9], [S10], [S11], [S19], [S1]

### Free/paid availability: avoid overclaiming

- Slack Free exposes only the most recent **90 days** of message/file history; content older than **one year** is deleted. Free workspaces are limited to **10 third-party or custom app installations**. History API documentation explicitly describes `is_limited` for free teams with older inaccessible messages. A connector must not promise it can recover hidden/deleted history. [S29], [S9, Message types]
- Neither the `search.messages` reference nor history/replies references state a blanket paid-plan prerequisite. That is **not** a guarantee of every app/scope being approved on every Free workspace. App-install policies, visibility, history availability, and distribution restrictions remain separate. [S5], [S9], [S10], [S3]
- RTS defaults to keyword retrieval if Slack AI Search is unavailable. The guide says natural-language questions are supported for paid plans; it specifically instructs a semantic-search disclaimer requiring **Business+ or Enterprise+**, and says semantic search needs a plan including Slack AI Search. `assistant.search.info` exposes `is_ai_search_enabled`. [S7, Search capabilities; General usage guidelines], [S30]
- **Unresolved:** the reviewed current pages do not provide a complete, unambiguous Free/Pro eligibility matrix for keyword RTS in a new external integration. The agent-development guide says **some** AI features require a paid plan; that is insufficient to claim all RTS requires a paid plan, or that keyword RTS definitely works on every Free plan. The method also lists `feature_not_enabled`. No workspace was queried. [S31], [S7], [S18]
- Workspace **guests are excluded from RTS**, per the RTS guide. This is distinct from paid-plan eligibility and ordinary full-member permissions. [S7, Guest access]

## 6. Data-use and answer-retention gates

For applications offered outside the developer's organization, the API Terms require **explicit authorization from the installing organization** for using, processing, and storing API Data. They limit that handling to the minimum necessary for the app's functionality; prohibit LLM training, bulk message/file exports absent express additional authorization, and using one organization's data to directly benefit another organization or third party. The developer must provide a user agreement and privacy policy. OAuth success alone does not demonstrate that all these obligations are met. [S1, Transparency & Reporting; Data Usage by Third Parties]

For RTS/Data Access, the Terms prohibit unrelated background collection/scraping and persistent copies, archives, indexes, or long-term stores of other organizations' API Data. They allow **limited temporary handling/caching/storage only as essential for immediate operation, performance, delivery, or law**, with prompt deletion after those needs, and no product-improvement use. The RTS guide uses broader “must not store or copy” wording; the Terms' stated precedence and specific temporary-handling language must be kept visible rather than flattened into either “all storage allowed” or “no transient processing possible.” [S1, Data Access API and Real-Time Search API; Entire Agreement], [S7, Data privacy]

The RTS guide expressly describes supplying results as LLM context, so **inference is not synonymous with prohibited training**. However, the Developer Policy also contains a broad prohibition on renting, selling, or sharing Data with third parties. **Unresolved:** how the intended model-provider processing, logs, saved chat/tool results, answer excerpts, and citations satisfy these provisions and any applicable agreements. This research does not establish blanket permission for arbitrary model providers or indefinite retention of retrieved content/derived answers. The exact treatment of persistent generated summaries is not comprehensively specified in the reviewed pages. [S7, introduction], [S2, Use of Data], [S1]

Slack also prohibits undermining access controls (including exposing private-channel content to someone without access), and its RTS guidance prohibits sharing Slack authorization between service users. A read-only connector still has these confidentiality and downstream-answer obligations. [S1, API Access], [S7, General usage guidelines], [S15]

## 7. Open gates for the interview

These are unresolved facts/requirements, not questions to the user or new decisions:

1. **Authorized audience/distribution:** no evidence yet establishes that the intended externally used, commercially connected OpenWork app is authorized without Marketplace approval, or qualifies for the narrowly worded single-third-party exception. [S1], [S3]
2. **Eligible search route:** direct RTS expressly excludes unlisted distributed apps; legacy search has documented restrictions and no clear new-app eligibility assurance for this use case. A separate commercial agreement, if one exists, must not be presumed to confer RTS eligibility automatically. [S1], [S5], [S6], [S7], [S8]
3. **Acceptable read performance:** the new-unlisted history/replies limits may materially constrain “read threads”; RTS has its own supplement limits. [S9], [S10], [S18]
4. **User and plan envelope:** private/DM inclusion, member consent, guest exclusion, history limits, and unresolved keyword-RTS plan support remain distinct constraints. [S7], [S9], [S21], [S29]
5. **Data lifecycle and model processing:** immediate retrieval is documented; persistent answers/tool transcripts and downstream provider processing have not been cleared. [S1], [S2], [S7]

No app was created or distributed, no credentials were acquired, no Slack data was accessed, no outreach or issue edits were performed, and no implementation was changed. This note does not rely on removed issue comments.

## 8. Internal-preview clarifications — rechecked 2026-09-28

Updated interview input: validation is now limited to OpenWork's own Slack workspace through hosted Connect, one workspace per member, with public/private channels and one-to-one/group DMs, live lookup and no background sync. External organizations remain disabled pending authorization and search eligibility. This changes the immediate audience, not the earlier evidence about external distribution; no actual app, installation, or permission was verified.

### In-Slack experience versus an OpenWork-side acceptance journey

The exact RTS **General usage guidelines** bullet is **“✅ DO have an in-Slack experience for your app.”** It is a directive under general RTS guidance, not phrased as “must,” “recommended,” or a Marketplace-only condition; that guide also expressly includes internal apps. It supplies no internal/undistributed exception, definition of the minimum experience, or requirement to conduct an initial acceptance test inside Slack. The API Terms require conformance with documentation, so the “guidelines” heading alone does not establish that the bullet is optional. [S7, General usage guidelines], [S1, API Access]

The same guide explicitly supports **“When a user interacts with a third-party service that has an active Slack connection outside of the Slack client. With this method, a user token is required.”** User-token RTS calls need no `action_token`. Thus the **post-authorization search/read/answer journey outside Slack is a documented technical call pattern**; that does not answer whether the app as a whole may have zero in-Slack functionality. OAuth and private/DM consent still involve Slack. No reviewed source defines an additional mandatory Slack-side function specifically for an internal preview, nor expressly waives the general in-Slack-experience directive. That app-level interpretation remains unresolved. [S7], [S18], [S12], [S21]

Separately, Marketplace suitability rules exclude apps that **“do not include functionality in Slack”** and **“provide only an MCP server without meaningful in-Slack functionality.”** Those are expressly listing/review conditions and should not be relabeled as an internal app's acceptance-test requirement. [S8]

### Own-organization data is materially different, but not a blanket exemption

The precise API-specific prohibition is: **“When using these APIs as a third-party Application provider, you may not create persistent copies, archives, indexes, or long-term data stores of other organizations’ API Data.”** The temporary-storage allowance also refers to **“other organizations’ API Data.”** The separate Data Usage by Third Parties section starts **“If you offer your Application for use by others outside your organization”** and later **“As the provider of an Application offered for use outside your organization.”** Those qualifications must not be dropped when discussing same-company use. [S1]

A newly located first-party clarification makes that distinction explicit: Slack's [October 13, 2025 terms-update explanation](https://docs.slack.dev/changelog/2025/10/13/api-terms-update/) says Distribution Beyond Your Organization **“has always only applied to applications distributed beyond your organization (i.e., third-party apps, not custom internal ones)”**. It also says the Data Access/RTS text was rearranged **“to be clear that it applies to third parties only now that customers may access the Data Access API.”** This supports the limited finding that those particular third-party clauses are not an undifferentiated ban on a custom internal app handling its own organization's data. It is not authorization for every storage/processing practice. The current Terms remain controlling over this explanatory changelog. [S1]

Other text is broader: RTS Data privacy says **“You must not store or copy any of the data retrieved from this API.”** The Developer Policy's Use of Data section prohibits **“Using Data to train an LLM under any circumstances”** and **“Renting, selling or sharing Data with third parties under any circumstances”**, without an express internal-app exception. The policy defines Data broadly as user-submitted content, metadata, and token data. The Terms' precedence rule does not itself say that the absence of a same-company prohibition overrides every separate policy obligation. **Saved chat/tool-result retention for internal RTS remains unresolved by the combined texts**, including how persistent summaries/excerpts are classified. [S7, Data privacy], [S2], [S1]

**Inference itself is positively documented, not equated with training:** RTS says **“Supplying this data as context to a large language model (LLM) helps ensure more relevant and accurate responses to user queries.”** What remains unverified is the intended external model provider's role, permitted disclosure, retention, and other processing terms; the reviewed pages do not define a general processor exception to the policy's third-party-sharing language. Being an internal app does not expressly resolve that issue, but these sources also do not establish a blanket ban on ordinary LLM inference. [S7], [S2]

**Slack Connect prevents equating one workspace with exclusively own-company content.** RTS states **“The API will retrieve results from Slack Connect channels.”** [Slack Connect developer documentation](https://docs.slack.dev/apis/slack-connect/) says **“A shared channel doesn't belong to a single workspace”** and that apps encounter messages/users from other teams. The [data-management guide](https://slack.com/help/articles/115004152843-How-data-management-features-apply-to-Slack-Connect) distinguishes content sent by one's own members from external content governed by the sending organization's retention settings. No reviewed source says an internal app's access turns external-authored shared-channel data into exclusively its own organization's API Data or waives third-party handling restrictions. The exact application of those clauses to mixed-origin results remains unresolved. [S7], [S1]

### Partial private/DM consent is not necessarily whole-OAuth failure

- RTS says **“Your app must contain at least the `search:read.public` scope and can optionally contain any of the scopes following that in this list.”** Private/DM/MPDM search requires its corresponding user scope and consent; scope pages say users **“may revoke consent after it has been initially given.”** Public search is therefore a documented capability without private/DM search grants. [S7], [S21]
- Distinguish optional **RTS capabilities** from scopes configured as **optional during OAuth**. The latter are explicitly marked via app settings or `oauth_config.scopes.user_optional`, also present in `oauth_config.scopes.user`. Slack's [March 16, 2026 optional-scopes announcement](https://docs.slack.dev/changelog/2026/03/16/optional-scopes/) says users can choose permissions **“without blocking them from installing your app entirely.”** The OAuth guide says **“When a user doesn't grant an optional scope, your app should still function for features that don't require it.”** This is documented partial authorization, not a whole-flow failure. It does not establish that declining a scope configured as required yields the same outcome. [S12]
- A valid eligible user token with `search:read.public` can perform public-only RTS, and no bot/action token is needed. `channel_types` defaults to `public_channel`; requesting types not covered by granted scopes can return `missing_scope`: **“The requested channel types are not allowed by the provided scopes.”** Docs do not promise silently dropping unauthorized channel types from an all-types request. OAuth scope storage and handling absent optional grants are explicitly documented. [S7], [S18], [S12]
- The RTS scope pages describe consent **within the Slack client**; the OAuth guide describes optional selections during installation. They do not fully specify whether these are the same screen in every user-only flow or every revocation error shape. No such UI was inspected. The documentation supports a public-only usable grant with partial optional consent; it does not make that equivalent to successful validation of the agreed private/DM journey. [S7], [S21], [S12]

All newly linked primary sources in this section were retrieved on **2026-09-28**. This follow-up changed only this research note and does not approve an app, choose product behavior, or clear legal uncertainties.

## Source register

All sources below were directly retrieved on **2026-09-28**. Method/scope pages were often retrieved via Slack's `.md` representation; links below identify their canonical public pages. Effective dates belong to the documents, not the retrieval date. Older changelog prose is not used to override current terms or current method/eligibility guidance.

| ID | Primary source | Relevant sections |
| --- | --- | --- |
| S1 | [Slack API Terms of Service](https://slack.com/terms-of-service/api) | Effective October 10, 2025; definitions; API Access; Commercial Distribution; data use; API-specific terms; Entire Agreement |
| S2 | [Slack App Developer Policy](https://docs.slack.dev/developer-policy/) | Effective December 10, 2024; Application definition; Security; Business; Use of Data |
| S3 | [App lifecycle & distribution](https://docs.slack.dev/app-management/distribution/) | Undistributed, unlisted, listed; OAuth; SSL; admin approval |
| S4 | [Manage apps in an Enterprise organization](https://slack.com/help/articles/360000281563-Manage-apps-in-an-Enterprise-organization) | View apps: Source / Internal / Distributed |
| S5 | [`search.messages`](https://docs.slack.dev/reference/methods/search.messages/) | Facts; legacy notice; response; filters; limits |
| S6 | [`search:read`](https://docs.slack.dev/reference/scopes/search.read/) | User scope; compatible methods; legacy notice |
| S7 | [Using the Real-time Search API](https://docs.slack.dev/apis/web-api/real-time-search-api/) | Eligibility; OAuth; scopes; privacy; call patterns; plans; guests; usage guidelines |
| S8 | [Slack Marketplace app guidelines and requirements](https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements/) | Apps unsuitable for Slack Marketplace |
| S9 | [`conversations.history`](https://docs.slack.dev/reference/methods/conversations.history/) | User/bot visibility; app-class rate limits; free-team `is_limited` |
| S10 | [`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies/) | Scopes; thread pagination; app-class rate limits |
| S11 | [Web API rate limits](https://docs.slack.dev/apis/web-api/rate-limits/) | App types; per-method/team/app; all plans; HTTP 429 |
| S12 | [Installing via OAuth authorization code flow](https://docs.slack.dev/authentication/installing-with-oauth/) | `user_scope`; server code exchange; user token response; optional scopes; separate user flow |
| S13 | [Tokens](https://docs.slack.dev/authentication/tokens/) | User tokens; bot tokens |
| S14 | [`oauth.v2.access`](https://docs.slack.dev/reference/methods/oauth.v2.access/) | Client credentials; nested user response; rotation; organization installs |
| S15 | [Security best practices](https://docs.slack.dev/concepts/security/) | No distributed client secret; secret storage; token-owner isolation; least privilege |
| S16 | [`auth.test`](https://docs.slack.dev/reference/methods/auth.test/) | No additional scopes; user/workspace/enterprise identity |
| S17 | [`chat.getPermalink`](https://docs.slack.dev/reference/methods/chat.getPermalink/) | No additional scopes; thread links; rate limits |
| S18 | [`assistant.search.context`](https://docs.slack.dev/reference/methods/assistant.search.context/) | User/bot tokens; contextual messages; source links; paging; search and supplement limits |
| S19 | [Rate limit changes for non-Marketplace apps](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/) | Updated current text: new app/install limits, existing-install exemption; historical announcement dated May 29, 2025 |
| S20 | [Slack MCP server overview](https://docs.slack.dev/ai/slack-mcp-server/) | App Identity; Security; Authentication and Token Handling |
| S21 | [`search:read.private`](https://docs.slack.dev/reference/scopes/search.read.private/), [`search:read.im`](https://docs.slack.dev/reference/scopes/search.read.im/), [`search:read.mpim`](https://docs.slack.dev/reference/scopes/search.read.mpim/) | User-only scopes; consent in Slack; revocation |
| S22 | [Announcing Slack MCP and RTS](https://docs.slack.dev/changelog/2026/02/17/slack-mcp/) | February 17, 2026; Data Access evolution; granular search scopes |
| S23 | [`search:read.public`](https://docs.slack.dev/reference/scopes/search.read.public/) | Workspace intersection; public-channel membership not required |
| S24 | [`channels:history`](https://docs.slack.dev/reference/scopes/channels.history/), [`groups:history`](https://docs.slack.dev/reference/scopes/groups.history/), [`im:history`](https://docs.slack.dev/reference/scopes/im.history/), [`mpim:history`](https://docs.slack.dev/reference/scopes/mpim.history/) | Conversation-category scopes; history/replies compatibility |
| S25 | [`conversations.info`](https://docs.slack.dev/reference/methods/conversations.info/) | Metadata scopes |
| S26 | [`users.info`](https://docs.slack.dev/reference/methods/users.info/) | Profile and email scopes |
| S27 | [`oauth.v2.user.access`](https://docs.slack.dev/reference/methods/oauth.v2.user.access/) | User-only token flow and top-level response |
| S28 | [Using PKCE](https://docs.slack.dev/authentication/using-pkce/) | Public clients; secretless exchange; native redirect/rotation constraints |
| S29 | [Feature limitations on Slack Free](https://slack.com/help/articles/27204752526611-Feature-limitations-on-the-free-version-of-Slack) | 90-day visible history; one-year deletion; 10 app limit |
| S30 | [`assistant.search.info`](https://docs.slack.dev/reference/methods/assistant.search.info/) | `is_ai_search_enabled` |
| S31 | [Developing an agent](https://docs.slack.dev/ai/developing-agents/) | Some AI features require a paid plan |

[S1]: https://slack.com/terms-of-service/api
[S2]: https://docs.slack.dev/developer-policy/
[S3]: https://docs.slack.dev/app-management/distribution/
[S4]: https://slack.com/help/articles/360000281563-Manage-apps-in-an-Enterprise-organization
[S5]: https://docs.slack.dev/reference/methods/search.messages/
[S6]: https://docs.slack.dev/reference/scopes/search.read/
[S7]: https://docs.slack.dev/apis/web-api/real-time-search-api/
[S8]: https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements/
[S9]: https://docs.slack.dev/reference/methods/conversations.history/
[S10]: https://docs.slack.dev/reference/methods/conversations.replies/
[S11]: https://docs.slack.dev/apis/web-api/rate-limits/
[S12]: https://docs.slack.dev/authentication/installing-with-oauth/
[S13]: https://docs.slack.dev/authentication/tokens/
[S14]: https://docs.slack.dev/reference/methods/oauth.v2.access/
[S15]: https://docs.slack.dev/concepts/security/
[S16]: https://docs.slack.dev/reference/methods/auth.test/
[S17]: https://docs.slack.dev/reference/methods/chat.getPermalink/
[S18]: https://docs.slack.dev/reference/methods/assistant.search.context/
[S19]: https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/
[S20]: https://docs.slack.dev/ai/slack-mcp-server/
[S21]: https://docs.slack.dev/reference/scopes/search.read.private/
[S22]: https://docs.slack.dev/changelog/2026/02/17/slack-mcp/
[S23]: https://docs.slack.dev/reference/scopes/search.read.public/
[S24]: https://docs.slack.dev/reference/methods/conversations.history/
[S25]: https://docs.slack.dev/reference/methods/conversations.info/
[S26]: https://docs.slack.dev/reference/methods/users.info/
[S27]: https://docs.slack.dev/reference/methods/oauth.v2.user.access/
[S28]: https://docs.slack.dev/authentication/using-pkce/
[S29]: https://slack.com/help/articles/27204752526611-Feature-limitations-on-the-free-version-of-Slack
[S30]: https://docs.slack.dev/reference/methods/assistant.search.info/
[S31]: https://docs.slack.dev/ai/developing-agents/
[S1, introductory paragraphs; Relationships & Definitions; API Access]: https://slack.com/terms-of-service/api
[S1, Commercial Distribution; Entire Agreement]: https://slack.com/terms-of-service/api
[S2, introduction; Security; Business]: https://docs.slack.dev/developer-policy/
[S1, Commercial Distribution]: https://slack.com/terms-of-service/api
[S4, View apps in your org]: https://slack.com/help/articles/360000281563-Manage-apps-in-an-Enterprise-organization
[S8, Apps unsuitable for Slack Marketplace]: https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements/#suitable
[S7, General usage guidelines]: https://docs.slack.dev/apis/web-api/real-time-search-api/#guidelines
[S7, User authentication; Required Scopes; Data privacy]: https://docs.slack.dev/apis/web-api/real-time-search-api/
[S7, Context call pattern]: https://docs.slack.dev/apis/web-api/real-time-search-api/#context-call-pattern
[S9, Usage info]: https://docs.slack.dev/reference/methods/conversations.history/#usage-info
[S15, Safe token storage; Session layer]: https://docs.slack.dev/concepts/security/
[S7, Data privacy]: https://docs.slack.dev/apis/web-api/real-time-search-api/#privacy
[S12, User-centric flow; Requesting scopes]: https://docs.slack.dev/authentication/installing-with-oauth/
[S15, Securely manage credentials and secrets]: https://docs.slack.dev/concepts/security/#manage-creds
[S12, Optional scopes; Appending scopes]: https://docs.slack.dev/authentication/installing-with-oauth/
[S14, Response]: https://docs.slack.dev/reference/methods/oauth.v2.access/#response
[S18, Rate limiting]: https://docs.slack.dev/reference/methods/assistant.search.context/#rate-limiting
[S9, Message types]: https://docs.slack.dev/reference/methods/conversations.history/#message-types
[S7, Search capabilities; General usage guidelines]: https://docs.slack.dev/apis/web-api/real-time-search-api/
[S7, Guest access]: https://docs.slack.dev/apis/web-api/real-time-search-api/#guests
[S1, Transparency & Reporting; Data Usage by Third Parties]: https://slack.com/terms-of-service/api
[S1, Data Access API and Real-Time Search API; Entire Agreement]: https://slack.com/terms-of-service/api
[S7, introduction]: https://docs.slack.dev/apis/web-api/real-time-search-api/
[S2, Use of Data]: https://docs.slack.dev/developer-policy/
[S1, API Access]: https://slack.com/terms-of-service/api
